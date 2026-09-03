import { describe, expect, it } from 'vitest'
import {
  firstPositional,
  hasFlag,
  readFlag,
  readRepeatedFlag,
} from '../../packages/core/src/cli/args.js'

describe('测试套件：CLI args', () => {
  it('验证：reads a separate flag value', () => {
    expect(readFlag(['--workspace', '/tmp/ws', 'task'], '--workspace')).toBe('/tmp/ws')
  })

  it('验证：reads an equals-form flag', () => {
    expect(readFlag(['--workspace=/tmp/ws', 'task'], '--workspace')).toBe('/tmp/ws')
  })

  it('验证：keeps the prompt when a flag uses equals form', () => {
    expect(firstPositional(['--workspace=/tmp/ws', '将 package.json 改成 2.0.0'])).toBe(
      '将 package.json 改成 2.0.0',
    )
  })

  it('验证：reads boolean and repeated flags', () => {
    const argv = ['--allow-host-verification', '--test-arg=-m', '--test-arg', 'pytest']
    expect(hasFlag(argv, '--allow-host-verification')).toBe(true)
    expect(readRepeatedFlag(argv, '--test-arg')).toEqual(['-m', 'pytest'])
  })

  it('验证：does not consume a positional prompt after a boolean flag', () => {
    expect(firstPositional(['--plan', '分析这个项目'])).toBe('分析这个项目')
  })

  it('验证：resume 和 session 参数不会被当作任务文本', () => {
    expect(firstPositional(['--resume', 'default'])).toBeUndefined()
    expect(firstPositional(['--session=work', '--interactive'])).toBeUndefined()
  })
})
