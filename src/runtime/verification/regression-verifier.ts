import type { TaskSpec } from '../../core/task/task-spec.js'
import type { AgentWorkspaceView } from '../../eval/ports/agent.port.js'
import { runVerificationCommands, toSnapshot } from './baseline-recorder.js'
import type { BaselineSnapshot } from './baseline-snapshot.js'
import { clipEvidence, clipHeadTail, MAX_EVIDENCE_CHARS } from './clip-text.js'
import { verifyCommands } from './command-verifier.js'
import { listTestFiles } from './test-files.js'
import type { CompletionCheck } from './verification-result.js'

export async function verifyRegression(
  taskSpec: TaskSpec,
  workspace: AgentWorkspaceView,
  baseline?: BaselineSnapshot,
): Promise<CompletionCheck> {
  if (taskSpec.verificationCommands.length === 0) {
    return { passed: true, message: 'No verification commands', evidence: [] }
  }

  if (!workspace.exec) {
    return {
      passed: false,
      message: 'Workspace cannot execute verification commands',
      evidence: taskSpec.verificationCommands,
    }
  }

  const exec = workspace.exec.bind(workspace)

  if (baseline && baseline.testFiles.length > 0) {
    const currentFiles = await listTestFiles(workspace.root)
    const missing = baseline.testFiles.filter((item) => !currentFiles.includes(item))
    if (missing.length > 0) {
      return {
        passed: false,
        message: `Test files deleted: ${missing.join(', ')}`,
        evidence: missing,
      }
    }
  }

  if (!baseline) {
    return verifyCommands(taskSpec, exec)
  }

  const run = await runVerificationCommands(taskSpec, exec)
  const final = toSnapshot(taskSpec, baseline.testFiles, run)
  return clipCheck(compareBaseline(baseline, final), run.output)
}

export function compareBaseline(
  baseline: BaselineSnapshot,
  final: Pick<BaselineSnapshot, 'failing' | 'exitCode' | 'fingerprint'>,
): CompletionCheck {
  const added = final.failing.filter((item) => !baseline.failing.includes(item))
  if (added.length > 0) {
    return {
      passed: false,
      message: `New regressions: ${added.slice(0, 20).join(', ')}`,
      evidence: added,
    }
  }

  if (baseline.failing.length > 0 || final.failing.length > 0) {
    return {
      passed: true,
      message: 'No new test regressions',
      evidence: final.failing,
    }
  }

  if (baseline.exitCode === 0 && final.exitCode === 0) {
    return { passed: true, message: 'Verification commands passed', evidence: [] }
  }
  if (baseline.exitCode === 0 && final.exitCode !== 0) {
    return {
      passed: false,
      message: 'New regressions',
      evidence: final.fingerprint ? [final.fingerprint] : ['exit non-zero'],
    }
  }
  if (final.exitCode === 0) {
    return { passed: true, message: 'Verification commands passed', evidence: [] }
  }
  if (baseline.fingerprint && final.fingerprint && baseline.fingerprint === final.fingerprint) {
    return {
      passed: true,
      message: 'No new test regressions',
      evidence: [final.fingerprint],
    }
  }
  return {
    passed: false,
    message: 'New regressions',
    evidence: [final.fingerprint ?? 'fingerprint-changed'],
  }
}

function clipCheck(check: CompletionCheck, output: string): CompletionCheck {
  const evidence = check.passed
    ? clipEvidence(check.evidence)
    : clipEvidence([...check.evidence, clipHeadTail(output, MAX_EVIDENCE_CHARS)])
  return {
    passed: check.passed,
    message: clipHeadTail(check.message, MAX_EVIDENCE_CHARS),
    evidence,
  }
}
