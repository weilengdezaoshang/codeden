import path from 'node:path'
import type { TaskSpec } from '@codeden/core/task/task-spec.js'
import { SensitivePathPolicy } from '@codeden/core/security/sensitive-path-policy.js'
import { isIgnoredWorkspacePath } from '../workspace/ignored-paths.js'
import type { CompletionCheck } from './verification-result.js'

const sensitivePaths = new SensitivePathPolicy()

export function verifyDiffPolicy(taskSpec: TaskSpec, changedPaths: string[]): CompletionCheck {
  const relevant = changedPaths.filter((item) => !isIgnoredWorkspacePath(item))
  const secretChanges = relevant.filter((item) => sensitivePaths.isSensitive(item))
  if (secretChanges.length > 0) {
    return {
      passed: false,
      message: `Sensitive paths changed: ${secretChanges.join(', ')}`,
      evidence: secretChanges,
    }
  }
  const allowed = taskSpec.allowedPaths
  const unexpected = relevant.filter((item) => !isAllowed(item, allowed))
  if (unexpected.length > 0) {
    return {
      passed: false,
      message: `Unexpected changed paths: ${unexpected.join(', ')}`,
      evidence: unexpected,
    }
  }

  const requiresChange = !allowed.includes('.')
  if (requiresChange && relevant.length === 0) {
    return {
      passed: false,
      message: 'No allowed files were changed',
      evidence: allowed,
    }
  }

  return {
    passed: true,
    message: `Changed paths are within allowed set: ${relevant.join(', ') || '(none)'}`,
    evidence: relevant,
  }
}

function isAllowed(changed: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) => {
    if (allowed === '.' || allowed === './') {
      return true
    }
    const normalizedChanged = changed.replaceAll('\\', '/')
    const normalizedAllowed = allowed.replaceAll('\\', '/')
    return (
      normalizedChanged === normalizedAllowed ||
      normalizedChanged.startsWith(`${normalizedAllowed}/`) ||
      path.posix.normalize(normalizedChanged) === path.posix.normalize(normalizedAllowed)
    )
  })
}
