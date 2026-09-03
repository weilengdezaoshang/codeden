import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { contentDigest } from '@codeden/core/content-digest.js'
import { assertSafeRelativePath } from '@codeden/core/filesystem/workspace-boundary.js'
import { readTraceEvents, readTraceTerminal } from './trace-file-reader.js'
import { buildMetadataUploadEnvelope, traceIdentifier } from './trace-upload-envelope.js'
import type { TraceOutbox } from './trace-outbox.js'

/** 只补偿终态落盘时已授权、且当前授权仍相同的 metadata-only Trace。 */
export async function recoverTraceOutbox(
  projectRoot: string,
  outbox: TraceOutbox,
  consentId: string,
  limit = 20,
): Promise<void> {
  const directory = path.join('.codeden', 'traces')
  await assertSafeRelativePath(projectRoot, directory)
  const entries = await readdir(path.join(projectRoot, directory), { withFileTypes: true })
  let attempted = 0
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/u.test(entry.name)) {
      continue
    }
    try {
      const relativePath = path.join(directory, entry.name)
      const terminal = await readTraceTerminal(projectRoot, relativePath)
      if (!terminal || captureConsentDigest(terminal.data) !== contentDigest(consentId)) {
        continue
      }
      if (await outbox.contains(traceIdentifier(terminal.runId, terminal.trialId))) {
        continue
      }
      if (attempted++ >= limit) {
        break
      }
      const events = await readTraceEvents(projectRoot, relativePath)
      // 文件变化或不完整读取不能利用旧尾部授权为新内容封箱。
      if (contentDigest(events.at(-1)) !== contentDigest(terminal)) {
        continue
      }
      await outbox.enqueue(buildMetadataUploadEnvelope(events, { granted: true, consentId }))
    } catch {
      // 单条损坏、磁盘失败或符号链接不能阻断其他 Trace 的补偿。
    }
  }
}

export function captureConsentDigest(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || !('captureConsentDigest' in data)) {
    return undefined
  }
  const value = data.captureConsentDigest
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined
}
