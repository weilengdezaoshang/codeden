import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { parseEvalCase } from '../../packages/eval-engine/src/domain/eval-case.js'

const caseRoot = path.resolve('evals/cases')

async function loadCase(suite: string, file: string) {
  const raw = await readFile(path.join(caseRoot, suite, file), 'utf8')
  return parseEvalCase(parse(raw))
}

describe('测试套件：validation 与 robustness 初始用例', () => {
  it('验证：validation 套件 mock 回复信封用例可解析且预算受限', async () => {
    const parsed = await loadCase('validation', 'mock-reply-envelope.yaml')
    expect(parsed.suite).toBe('validation')
    expect(parsed.limits.maxTurns).toBe(3)
    expect(JSON.stringify(parsed.verification?.graders)).toContain('token-budget')
  })

  it('验证：robustness 套件预算信封用例可解析（极小预算）', async () => {
    const parsed = await loadCase('robustness', 'budget-exhausted-envelope.yaml')
    expect(parsed.suite).toBe('robustness')
    expect(parsed.limits.maxTurns).toBe(1)
    expect(parsed.limits.maxToolCalls).toBe(1)
    expect(JSON.stringify(parsed.verification?.graders)).toContain('token-budget')
  })
})
