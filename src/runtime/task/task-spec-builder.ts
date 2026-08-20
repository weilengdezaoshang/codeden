import { parseTaskSpec, type TaskSpec } from '../../core/task/task-spec.js'
import type { ProjectFacts } from '../project/project-facts.js'

const FILE_PATTERN = /(?<path>[\w./-]+\.(?:json|ts|tsx|js|mjs|cjs|md|ya?ml|css))/g
const RESTRICT_HINT =
  /不要改其他|不得修改其他|只改|仅修改|don't change other|do not (?:change|modify|edit) other|only (?:change|edit|modify)|no other files/i
const EDIT_HINT = /改成|改为|修改|更新|写入|edit|change|update|write\b/i

export function buildTaskSpec(prompt: string, facts: ProjectFacts, id = 'cli-task'): TaskSpec {
  const mentioned = unique(matchFiles(prompt))
  const restrict = RESTRICT_HINT.test(prompt)
  const edit = EDIT_HINT.test(prompt)
  const allowedPaths = mentioned.length > 0 && (restrict || edit) ? mentioned : ['.']
  const verificationCommands = pickVerificationCommands(prompt, facts)
  const constrained = restrict || (edit && mentioned.length > 0)

  return parseTaskSpec({
    id,
    goal: prompt.trim(),
    acceptanceCriteria: constrained ? ['不得修改未允许的文件'] : [],
    constraints: constrained ? ['不得修改其他文件'] : [],
    allowedPaths,
    verificationCommands,
  })
}

function matchFiles(prompt: string): string[] {
  return [...prompt.matchAll(FILE_PATTERN)].flatMap((match) => {
    const value = match.groups?.path
    return value ? [value.replace(/^\.\//, '')] : []
  })
}

function pickVerificationCommands(prompt: string, facts: ProjectFacts): string[] {
  if (!/运行测试|跑测试|pnpm test|npm test/.test(prompt) || !facts.scripts.test) {
    return []
  }
  if (facts.packageManager === 'pnpm') {
    return ['pnpm test']
  }
  if (facts.packageManager === 'npm') {
    return ['npm test']
  }
  if (facts.packageManager === 'yarn') {
    return ['yarn test']
  }
  return []
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}
