import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// 随构建产物携带锁文件指纹，使独立部署不依赖仓库根目录。
const root = new URL('../', import.meta.url)
const target = fileURLToPath(new URL('packages/eval-engine/dist/build-provenance.json', root))

export async function invalidateBuildProvenance() {
  await rm(target, { force: true })
}

export async function stampBuildProvenance() {
  const lock = await readFile(new URL('pnpm-lock.yaml', root))
  const manifest = { schemaVersion: 1, lockDigest: createHash('sha256').update(lock).digest('hex') }
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(manifest), { flag: 'wx' })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}
