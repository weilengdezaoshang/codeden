import { readdir, rm, lstat } from 'node:fs/promises'
import path from 'node:path'
import type { Clock } from '../core/clock.js'
import type { SecurityServices } from '../security/security-services.js'
import { assertSafeRelativePath } from '../runtime/workspace/workspace-boundary.js'
import { LocalTraceRecorder } from './local-trace-recorder.js'
import { TraceCaptureSink } from './trace-capture-sink.js'
import { TraceOutbox } from './trace-outbox.js'
import { recoverTraceOutbox, captureConsentDigest } from './trace-outbox-recovery.js'
import { readTraceTerminal } from './trace-file-reader.js'
import { traceIdentifier } from './trace-upload-envelope.js'
import { contentDigest } from '../core/content-digest.js'

export async function createTraceCaptureSink(input: {
  projectRoot: string
  runId: string
  trialId: string
  security: SecurityServices
  telemetry: {
    enabled: boolean
    consentId?: string
    traceRetentionDays: number
    maxTraceFiles: number
  }
  clock?: Clock
}): Promise<TraceCaptureSink> {
  // 维护失败不能阻止用户执行任务；实际记录错误由 BestEffortEventSink 隔离。
  const outbox = input.telemetry.enabled
    ? new TraceOutbox(input.projectRoot, input.clock)
    : undefined
  if (outbox && input.telemetry.consentId) {
    await recoverTraceOutbox(input.projectRoot, outbox, input.telemetry.consentId).catch(
      () => undefined,
    )
  }
  await pruneLocalTraces(input.projectRoot, input.telemetry).catch(() => undefined)
  return new TraceCaptureSink({
    recorder: new LocalTraceRecorder({
      projectRoot: input.projectRoot,
      runId: input.runId,
      trialId: input.trialId,
      clock: input.clock,
      redactor: input.security.redactor,
      guard: input.security.guard,
    }),
    outbox,
    consent: {
      granted: input.telemetry.enabled,
      consentId: input.telemetry.consentId,
    },
  })
}

export async function pruneLocalTraces(
  projectRoot: string,
  policy: {
    traceRetentionDays: number
    maxTraceFiles: number
    enabled?: boolean
    consentId?: string
  },
): Promise<void> {
  const relativeDirectory = path.join('.codeden', 'traces')
  const directory = path.join(projectRoot, relativeDirectory)
  let names: string[]
  try {
    await assertSafeRelativePath(projectRoot, relativeDirectory)
    names = (await readdir(directory)).filter((name) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/u.test(name),
    )
  } catch (error) {
    if (isMissing(error)) {
      return
    }
    throw error
  }
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      modifiedAt: (await lstat(path.join(directory, name))).mtimeMs,
    })),
  )
  files.sort(
    (left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name),
  )
  const cutoff = Date.now() - policy.traceRetentionDays * 24 * 60 * 60_000
  const expired = files.filter(
    (file, index) =>
      (index >= policy.maxTraceFiles || file.modifiedAt < cutoff) &&
      file.modifiedAt < Date.now() - 10 * 60_000,
  )
  for (const file of expired) {
    try {
      const relativePath = path.join(relativeDirectory, file.name)
      const terminal = await readTraceTerminal(projectRoot, relativePath)
      if (!terminal) {
        continue
      }
      const consent = captureConsentDigest(terminal.data)
      if (
        consent &&
        policy.enabled !== false &&
        (!policy.consentId || consent === contentDigest(policy.consentId))
      ) {
        const outbox = new TraceOutbox(projectRoot)
        if (!(await outbox.contains(traceIdentifier(terminal.runId, terminal.trialId)))) {
          continue
        }
      }
      await rm(path.join(directory, file.name), { force: true })
    } catch {
      // 无法确认终态或补偿状态的文件不能被清理，继续处理其他文件。
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
