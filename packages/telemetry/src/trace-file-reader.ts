import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { parseRunEvent, type RunEvent } from '@codeden/core/events/run-event.js'
import { assertSafeRelativePath } from '@codeden/core/filesystem/workspace-boundary.js'

export async function readTraceEvents(
  projectRoot: string,
  relativePath: string,
  maxBytes = 16_000_000,
): Promise<RunEvent[]> {
  await assertSafeRelativePath(projectRoot, relativePath)
  const handle = await open(
    path.join(projectRoot, relativePath),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error('Trace 文件过大或类型无效')
    }
    // 有界读取，防止 stat 后文件继续增长而无限读取。
    const buffer = await readExactly(handle, info.size, 0)
    if ((await handle.stat()).size !== info.size) {
      throw new Error('Trace 文件正在变化')
    }
    return buffer
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => parseRunEvent(JSON.parse(line) as unknown))
  } finally {
    await handle.close()
  }
}

export async function readTraceTerminal(
  projectRoot: string,
  relativePath: string,
): Promise<RunEvent | undefined> {
  await assertSafeRelativePath(projectRoot, relativePath)
  const handle = await open(
    path.join(projectRoot, relativePath),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      return undefined
    }
    const size = Math.min(64_000, info.size)
    const buffer = await readExactly(handle, size, info.size - size)
    const line = buffer.toString('utf8').trim().split('\n').at(-1)
    const event = line ? parseRunEvent(JSON.parse(line) as unknown) : undefined
    return event?.type === 'agent.completed' && isRootTraceData(event.data) ? event : undefined
  } finally {
    await handle.close()
  }
}

async function readExactly(handle: FileHandle, size: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, position + offset)
    if (!bytesRead) {
      throw new Error('Trace 文件读取不完整')
    }
    offset += bytesRead
  }
  return buffer
}

export function isRootTraceData(data: unknown): boolean {
  return !(data && typeof data === 'object' && 'agentDepth' in data && data.agentDepth)
}
