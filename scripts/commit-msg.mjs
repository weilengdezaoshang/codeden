import { readFileSync } from 'node:fs'

const TYPES = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'test',
  'perf',
  'style',
  'build',
  'ci',
  'chore',
  'revert',
]
const FORBIDDEN_SCOPES = new Set(['all', 'misc', 'other'])
const FUZZY_SUBJECTS = new Set([
  '新增功能',
  '修复问题',
  '修改代码',
  '更新内容',
  '处理问题',
  '更新项目',
])

const headerPattern = new RegExp(`^(${TYPES.join('|')})\\(([a-z][a-z0-9-]*)\\)(!)?: (.+)$`)

const messagePath = process.argv[2]
if (!messagePath) {
  console.error('commit-msg: 缺少提交信息文件路径')
  process.exit(1)
}

const message = readFileSync(messagePath, 'utf8')
const header = message
  .split('\n')
  .find((line) => line.trim() && !line.startsWith('#'))
  ?.trim()

if (!header) {
  fail('提交信息不能为空')
}

if (header.startsWith('Merge ') || header.startsWith('Revert ')) {
  process.exit(0)
}

const matched = header.match(headerPattern)
if (!matched) {
  fail(
    [
      '提交信息必须使用以下格式：',
      '',
      '  type(模块): 中文描述.',
      '',
      '示例：feat(runtime): 新增 Agent 最小执行循环.',
    ].join('\n'),
  )
}

const [, , scope, , subject] = matched

if (FORBIDDEN_SCOPES.has(scope)) {
  fail(`不要使用含义模糊的模块名：${scope}`)
}

if (!subject.endsWith('.')) {
  fail('描述必须以英文句点 "." 结尾')
}

if (!/[\u4e00-\u9fff]/.test(subject)) {
  fail('描述必须使用简体中文')
}

const normalized = subject.slice(0, -1).trim()
if (FUZZY_SUBJECTS.has(normalized)) {
  fail('描述不能使用“修改代码”“更新内容”“处理问题”等模糊说法')
}

function fail(detail) {
  console.error(`commit-msg: ${detail}`)
  process.exit(1)
}
