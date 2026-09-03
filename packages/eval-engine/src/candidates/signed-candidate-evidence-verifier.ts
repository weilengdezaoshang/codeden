import { constants } from 'node:fs'
import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { contentDigest } from '@codeden/core/content-digest.js'
import { assertSafeRelativePath } from '@codeden/core/filesystem/workspace-boundary.js'
import type { CandidateEvidenceVerifier } from './candidate-evidence-verifier.js'
import type { EvalCandidate } from './eval-candidate.js'

export const CandidateReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
      .max(128),
  })
  .strict()

/** 公钥由评测管理员注入，不能从候选或回执自身读取。签名方负责真实的隐私检测、复现和复审。 */
export class SignedCandidateEvidenceVerifier implements CandidateEvidenceVerifier {
  private readonly publicKey: KeyObject
  constructor(
    private readonly projectRoot: string,
    trustedPublicKey: string,
  ) {
    this.publicKey = createPublicKey(trustedPublicKey)
    if (this.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('候选凭证要求 Ed25519 公钥')
    }
  }

  async verify(candidate: EvalCandidate, input: unknown) {
    const parsed = CandidateReceiptSchema.safeParse(input)
    const checks = [
      {
        id: 'signature',
        passed:
          parsed.success &&
          parsed.data.candidateDigest === contentDigest(candidate) &&
          verify(
            null,
            Buffer.from(parsed.data.candidateDigest),
            this.publicKey,
            Buffer.from(parsed.data.signature, 'base64'),
          ),
        message: '凭证必须由可信审核方签名并绑定完整候选内容',
      },
    ]
    if (checks[0]!.passed) {
      let matches = false
      try {
        matches =
          !candidate.evalCase.fixture.repository &&
          (await digestCandidateFixture(this.projectRoot, candidate.evalCase.fixture.path)) ===
            candidate.fixture.contentSha256
      } catch {
        /* 不存在、越界、链接或过大 fixture 都失败关闭。 */
      }
      checks.push({
        id: 'fixture_digest',
        passed: matches,
        message: '本地独立 fixture 内容必须与审核版本一致',
      })
    }
    return { passed: checks.every((check) => check.passed), checks }
  }
}

/** 内容寻址包含路径、文件内容和执行位；拒绝符号链接与特殊文件。 */
export async function digestCandidateFixture(
  projectRoot: string,
  relativeRoot: string,
): Promise<string> {
  await assertSafeRelativePath(projectRoot, relativeRoot)
  const root = path.join(projectRoot, relativeRoot)
  if (!(await lstat(root)).isDirectory()) {
    throw new Error('fixture 必须是独立目录')
  }
  const files: Array<{ path: string; executable: boolean; content: string }> = []
  let bytes = 0
  let entriesSeen = 0
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 32) {
      throw new Error('fixture 目录过深')
    }
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (++entriesSeen > 2000) {
        throw new Error('fixture 文件过多')
      }
      const item = path.join(relative, entry.name)
      await assertSafeRelativePath(projectRoot, path.join(relativeRoot, item))
      if (entry.isDirectory()) {
        await visit(item, depth + 1)
        continue
      }
      if (!entry.isFile()) {
        throw new Error('fixture 不允许链接或特殊文件')
      }
      const handle = await open(path.join(root, item), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        bytes += info.size
        if (!info.isFile() || bytes > 10_000_000) {
          throw new Error('fixture 超出大小限制')
        }
        const content = await handle.readFile()
        if (content.length !== info.size) {
          throw new Error('fixture 正在变化')
        }
        files.push({
          path: item.split(path.sep).join('/'),
          executable: (info.mode & 0o111) !== 0,
          content: content.toString('base64'),
        })
      } finally {
        await handle.close()
      }
    }
  }
  await visit('', 0)
  return contentDigest(files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
}
