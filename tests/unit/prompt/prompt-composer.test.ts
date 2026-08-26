import { describe, expect, it } from 'vitest'
import { parseTaskSpec } from '../../../src/core/task/task-spec.js'
import { PromptComposer } from '../../../src/runtime/prompt/prompt-composer.js'

const task = {
  prompt: '实现功能',
  taskSpec: parseTaskSpec({
    id: 'task-1',
    goal: '完成一个功能',
    acceptanceCriteria: ['测试通过'],
    constraints: ['不要修改配置'],
    allowedPaths: ['src'],
  }),
}

describe('PromptComposer', () => {
  it('按固定顺序组装系统提示和当前任务', () => {
    const messages = new PromptComposer().compose({
      task,
      researchInstructions: ['Research when uncertain.'],
      readOnly: false,
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'system' })
    expect(messages[0]?.content).toContain('Goal: 完成一个功能')
    expect(messages[0]?.content).toContain('Acceptance criteria:\n- 测试通过')
    expect(messages[0]?.content).toContain('Constraints:\n- 不要修改配置')
    expect(messages[0]?.content).toContain('Allowed paths: src')
    expect(messages[0]?.content).toContain('Research when uncertain.')
    expect(messages[1]).toEqual({ role: 'user', content: '实现功能' })
  })

  it('在只读模式注入限制并保留历史顺序', () => {
    const messages = new PromptComposer().compose({
      task,
      researchInstructions: [],
      readOnly: true,
      conversation: [
        { role: 'user', content: '先分析' },
        { role: 'assistant', content: '分析完成' },
      ],
    })

    expect(messages[0]?.content).toContain(
      'Plan mode is enabled. Do not modify files or execute commands.',
    )
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: '先分析' },
      { role: 'assistant', content: '分析完成' },
      { role: 'user', content: '实现功能' },
    ])
  })

  it('处理空的可选字段且不注入只读提示', () => {
    const minimal = {
      prompt: '检查代码',
      taskSpec: parseTaskSpec({ id: 'minimal', goal: '检查代码' }),
    }
    const [system, current] = new PromptComposer().compose({
      task: minimal,
      researchInstructions: [],
      readOnly: false,
    })
    expect(system?.content).not.toContain('Plan mode is enabled')
    expect(system?.content).not.toContain('Acceptance criteria:')
    expect(system?.content).not.toContain('Constraints:')
    expect(current).toEqual({ role: 'user', content: '检查代码' })
  })
})
