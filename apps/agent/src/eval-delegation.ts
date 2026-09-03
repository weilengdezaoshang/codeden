import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:os'
import { killProcessGroup } from '@codeden/agent-runtime/process/kill-process-group.js'

const CANCELLATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
const CANCELLATION_GRACE_MS = 1_000

/** 评测是可选的独立可执行程序，Agent 包不加载其模块或依赖。 */
export async function delegateEvaluation(argv: string[]): Promise<number> {
  let child: ChildProcess
  try {
    child = spawn('codeden-eval', argv, {
      stdio: 'inherit',
      shell: false,
      detached: process.platform !== 'win32',
    })
  } catch {
    return reportLaunchError()
  }
  return waitForEvaluation(child)
}

function waitForEvaluation(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    let cancellation: NodeJS.Signals | undefined
    let forceKillTimer: NodeJS.Timeout | undefined
    let settled = false

    function cancel(signal: NodeJS.Signals) {
      if (settled) {
        return
      }
      if (cancellation) {
        killProcessGroup(child)
        return
      }
      cancellation = signal
      forwardSignal(child, signal)
      // 首次取消给清理流程一个短暂窗口，再次取消或超时则终止整个进程组。
      forceKillTimer = setTimeout(() => killProcessGroup(child), CANCELLATION_GRACE_MS)
    }

    const listeners = CANCELLATION_SIGNALS.map((signal) => {
      const listener = () => cancel(signal)
      process.on(signal, listener)
      return { signal, listener }
    })

    function finish(code: number) {
      if (settled) {
        return
      }
      settled = true
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      for (const { signal, listener } of listeners) {
        process.removeListener(signal, listener)
      }
      // 父评测进程可以先退出，仍须清理留在该组里的后代进程。
      if (cancellation) {
        killProcessGroup(child)
      }
      resolve(code)
    }

    child.once('error', () => {
      if (!settled) {
        finish(cancellation ? signalExitCode(cancellation) : reportLaunchError())
      }
    })
    child.once('exit', (code, signal) => {
      finish(cancellation ? signalExitCode(cancellation) : (code ?? signalExitCode(signal)))
    })
  })
}

function forwardSignal(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      /* 进程可能已结束，回退至单进程发送。 */
    }
  }
  try {
    child.kill(signal)
  } catch {
    /* 已结束。 */
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal ? 128 + (constants.signals[signal] ?? 0) : 2
}

function reportLaunchError(): number {
  console.error('评测工具未安装或无法启动。请在 monorepo 使用 pnpm eval，或安装 codeden-eval。')
  return 2
}
