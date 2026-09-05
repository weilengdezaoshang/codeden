import type { EventSink } from '@codeden/core/events/event-sink.js'
import type { RunEventSource } from '@codeden/core/events/run-event.js'
import type { TerminalUi } from './terminal-ui.js'

/** Converts runtime events into concise messages for the interactive terminal. */
export class TerminalUiEventSink implements EventSink {
  private readonly activeToolCalls = new Map<string, { toolName: string; arguments?: unknown }>()

  constructor(private readonly ui: TerminalUi) {}

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    const eventData = this.withRememberedToolArguments(type, data)
    this.ui.setStatus(statusForEvent(type, eventData))
    if (type === 'model.text_delta' && isTextDelta(data)) {
      this.ui.appendAssistantDelta(data.delta)
      return
    }
    if (type === 'model.completed') {
      this.ui.finishAssistantStream()
    }
    const detail = summarizeEvent(type, eventData)
    if (!detail) {
      return
    }
    if (type === 'model.requested') {
      this.ui.addMessage({ role: 'system', content: detail, activity: true })
      this.ui.beginAssistantStream()
      return
    }
    if (type === 'tool.started' || type === 'tool.completed' || type === 'tool.failed') {
      const callId = isToolEvent(eventData) ? eventData.callId : undefined
      if (callId) {
        this.ui.upsertActivity(`tool:${callId}`, detail)
        if (type !== 'tool.started') {
          this.activeToolCalls.delete(callId)
        }
        return
      }
    }
    this.ui.addMessage({
      role: source === 'tool' ? 'tool' : 'system',
      content: detail,
      activity: true,
    })
  }

  private withRememberedToolArguments(type: string, data: unknown): unknown {
    if (!isToolEvent(data) || !data.callId) {
      return data
    }
    if (type === 'tool.started') {
      this.activeToolCalls.set(data.callId, { toolName: data.toolName, arguments: data.arguments })
      return data
    }
    const remembered = this.activeToolCalls.get(data.callId)
    return remembered
      ? { ...remembered, ...data, arguments: data.arguments ?? remembered.arguments }
      : data
  }
}

function isTextDelta(data: unknown): data is { delta: string } {
  return Boolean(
    data && typeof data === 'object' && 'delta' in data && typeof data.delta === 'string',
  )
}

export function statusForEvent(type: string, data?: unknown): string {
  if (type === 'model.requested') {
    return '思考中'
  }
  if (type === 'tool.started' && isToolEvent(data)) {
    return toolStatus(data.toolName)
  }
  if (type.includes('verification')) {
    return type.endsWith('.failed') ? '验证未通过' : '正在验证'
  }
  if (type.includes('tool')) {
    return type.endsWith('.failed') ? '工具调用失败' : '正在使用工具'
  }
  if (type.endsWith('.failed')) {
    return '执行失败'
  }
  if (type.endsWith('.completed')) {
    return '已完成'
  }
  if (type.endsWith('.started') || type.endsWith('.requested')) {
    return '运行中'
  }
  return '处理中'
}

function toolStatus(toolName: string): string {
  switch (toolName) {
    case 'read_file':
      return '正在读取文件'
    case 'list_files':
      return '正在浏览工作区'
    case 'search_docs':
      return '正在搜索文档'
    case 'fetch_url':
      return '正在读取网页'
    case 'run_command':
      return '正在运行命令'
    case 'run_python':
      return '正在运行 Python 脚本'
    case 'edit_file':
      return '正在修改文件'
    case 'write_file':
      return '正在写入文件'
    case 'subagent':
      return '正在委派子 Agent'
    case 'apply_patch':
      return '正在应用补丁'
    case 'start_command':
      return '正在启动后台命令'
    case 'get_command_output':
      return '正在查询后台命令'
    case 'kill_command':
      return '正在终止后台命令'
    case 'get_diagnostics':
      return '正在收集诊断'
    case 'git_status':
      return '正在查看 Git 状态'
    case 'git_diff':
      return '正在查看 Git diff'
    case 'web_search':
      return '正在搜索网页'
    case 'web_fetch':
      return '正在抓取网页'
    case 'todo_write':
      return '正在更新任务计划'
    case 'delete_file':
      return '正在删除文件'
    case 'move_file':
      return '正在移动文件'
    case 'repo_map':
      return '正在生成仓库地图'
    case 'find_symbol':
      return '正在查找符号'
    case 'find_references':
      return '正在查找引用'
    case 'read_many_files':
      return '正在批量读取文件'
    case 'search_files':
      return '正在搜索文件'
    default:
      return `正在调用工具 ${safeToolName(toolName)}`
  }
}

export function summarizeEvent(type: string, data?: unknown): string {
  if (type === 'model.text_delta') {
    return ''
  }
  if (type === 'model.requested') {
    return '◌ 思考中…'
  }
  if (type === 'model.completed') {
    return ''
  }
  if (
    type === 'agent.started' ||
    type === 'agent.instructions_loaded' ||
    type === 'agent.completion_proposed' ||
    type === 'agent.submitted' ||
    type === 'agent.completed'
  ) {
    return ''
  }
  if (type === 'tool.started' && isToolEvent(data)) {
    return `▶ ${toolAction(data.toolName, data.arguments)}`
  }
  if (type === 'tool.completed' && isToolEvent(data)) {
    const duration =
      typeof data.durationMs === 'number' ? `（${Math.round(data.durationMs)}ms）` : ''
    return `✓ ${toolCompletedAction(data.toolName, data.arguments)}${duration}`
  }
  if (type === 'tool.failed' && isToolEvent(data)) {
    return `✗ ${toolFailedAction(data.toolName, data.arguments)}：${errorMessage(data.error)}`
  }
  if (type === 'verification.started') {
    return 'Verification started'
  }
  if (type === 'verification.completed') {
    return isVerificationEvent(data) && (data.status === 'passed' || data.passed === true)
      ? '✓ Verification passed'
      : 'Verification completed'
  }
  if (type === 'verification.failed') {
    return `✗ Verification failed${isVerificationEvent(data) && data.message ? `: ${data.message}` : ''}`
  }
  return type
}

function toolAction(toolName: string, arguments_: unknown): string {
  const path = argumentString(arguments_, 'path')
  switch (toolName) {
    case 'read_file':
      return `正在读取文件${path ? ` ${path}` : ''}`
    case 'list_files':
      return `正在浏览工作区${path && path !== '.' ? ` ${path}` : ''}`
    case 'search_docs': {
      const query = argumentString(arguments_, 'query')
      return `正在搜索文档${query ? ` “${preview(query, 48)}”` : ''}`
    }
    case 'fetch_url':
      return `正在读取网页${urlHost(argumentString(arguments_, 'url'))}`
    case 'run_command': {
      const command = argumentString(arguments_, 'command')
      const args = argumentStrings(arguments_, 'args')
      return `正在运行命令${command ? ` ${preview([command, ...args].join(' '), 72)}` : ''}`
    }
    case 'run_python': {
      const script = argumentString(arguments_, 'script')
      const args = argumentStrings(arguments_, 'args')
      return `正在运行 Python 脚本${script ? ` ${preview([script, ...args].join(' '), 72)}` : ''}`
    }
    case 'edit_file':
      return `正在修改文件${path ? ` ${path}` : ''}`
    case 'write_file':
      return `正在写入文件${path ? ` ${path}` : ''}`
    case 'subagent':
      return '正在委派子 Agent 分析任务'
    case 'apply_patch':
      return '正在应用补丁'
    case 'start_command':
      return '正在启动后台命令'
    case 'web_search':
      return '正在搜索网页'
    case 'web_fetch':
      return '正在抓取网页'
    case 'todo_write':
      return '正在更新任务计划'
    case 'delete_file':
      return '正在删除文件'
    case 'move_file':
      return '正在移动文件'
    case 'search_files':
      return '正在搜索文件'
    default:
      return `正在调用工具 ${safeToolName(toolName)}`
  }
}

function toolCompletedAction(toolName: string, arguments_: unknown): string {
  const path = argumentString(arguments_, 'path')
  switch (toolName) {
    case 'read_file':
      return `已读取文件${path ? ` ${path}` : ''}`
    case 'list_files':
      return `已浏览工作区${path && path !== '.' ? ` ${path}` : ''}`
    case 'search_docs':
      return '文档搜索完成'
    case 'fetch_url':
      return `已读取网页${urlHost(argumentString(arguments_, 'url'))}`
    case 'run_command':
      return '命令执行完成'
    case 'run_python':
      return 'Python 脚本执行完成'
    case 'edit_file':
      return `已修改文件${path ? ` ${path}` : ''}`
    case 'write_file':
      return `已写入文件${path ? ` ${path}` : ''}`
    case 'subagent':
      return '子 Agent 分析完成'
    case 'apply_patch':
      return '补丁应用完成'
    case 'start_command':
      return '后台命令已启动'
    case 'get_command_output':
      return '后台命令状态已查询'
    case 'kill_command':
      return '后台命令已终止'
    case 'get_diagnostics':
      return '诊断收集完成'
    case 'git_status':
      return 'Git 状态已获取'
    case 'git_diff':
      return 'Git diff 已获取'
    case 'web_search':
      return '网页搜索完成'
    case 'web_fetch':
      return '网页抓取完成'
    case 'todo_write':
      return '任务计划已更新'
    case 'delete_file':
      return `文件已删除${path ? ` ${path}` : ''}`
    case 'move_file':
      return '文件移动完成'
    case 'repo_map':
      return '仓库地图已生成'
    case 'find_symbol':
      return '符号查找完成'
    case 'find_references':
      return '引用查找完成'
    case 'read_many_files':
      return '批量读取完成'
    case 'search_files':
      return '文件搜索完成'
    default:
      return `工具 ${safeToolName(toolName)} 执行完成`
  }
}

function toolFailedAction(toolName: string, arguments_: unknown): string {
  const path = argumentString(arguments_, 'path')
  switch (toolName) {
    case 'read_file':
      return `读取文件失败${path ? ` ${path}` : ''}`
    case 'list_files':
      return '浏览工作区失败'
    case 'search_docs':
      return '文档搜索失败'
    case 'fetch_url':
      return '读取网页失败'
    case 'run_command':
      return '命令执行失败'
    case 'run_python':
      return 'Python 脚本执行失败'
    case 'edit_file':
      return `修改文件失败${path ? ` ${path}` : ''}`
    case 'write_file':
      return `写入文件失败${path ? ` ${path}` : ''}`
    case 'subagent':
      return '子 Agent 分析失败'
    case 'apply_patch':
      return '补丁应用失败'
    case 'start_command':
      return '后台命令启动失败'
    case 'get_command_output':
      return '后台命令查询失败'
    case 'kill_command':
      return '后台命令终止失败'
    case 'get_diagnostics':
      return '诊断收集失败'
    case 'git_status':
      return 'Git 状态获取失败'
    case 'git_diff':
      return 'Git diff 获取失败'
    case 'web_search':
      return '网页搜索失败'
    case 'web_fetch':
      return '网页抓取失败'
    case 'todo_write':
      return '任务计划更新失败'
    case 'delete_file':
      return `文件删除失败${path ? ` ${path}` : ''}`
    case 'move_file':
      return '文件移动失败'
    case 'repo_map':
      return '仓库地图生成失败'
    case 'find_symbol':
      return '符号查找失败'
    case 'find_references':
      return '引用查找失败'
    case 'read_many_files':
      return '批量读取失败'
    case 'search_files':
      return '文件搜索失败'
    default:
      return `工具 ${safeToolName(toolName)} 执行失败`
  }
}

/** Build a permission prompt from safe, user-relevant fields only. */
export function toolPermissionPrompt(toolName: string, arguments_: unknown): string {
  const path = argumentString(arguments_, 'path')
  switch (toolName) {
    case 'run_command': {
      const command = argumentString(arguments_, 'command')
      const args = argumentStrings(arguments_, 'args')
      return `即将运行命令${command ? ` ${preview([command, ...args].join(' '), 72)}` : ''}`
    }
    case 'run_python': {
      const script = argumentString(arguments_, 'script')
      return `即将运行 Python 脚本${script ? ` ${script}` : ''}`
    }
    case 'edit_file':
      return `即将修改文件${path ? ` ${path}` : ''}`
    case 'write_file':
      return `即将写入文件${path ? ` ${path}` : ''}`
    case 'subagent':
      return '即将委派子 Agent 分析任务'
    default:
      return `即将调用工具 ${safeToolName(toolName)}`
  }
}

function argumentString(arguments_: unknown, key: string): string | undefined {
  if (!arguments_ || typeof arguments_ !== 'object' || !(key in arguments_)) {
    return undefined
  }
  const value = (arguments_ as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function argumentStrings(arguments_: unknown, key: string): string[] {
  if (!arguments_ || typeof arguments_ !== 'object' || !(key in arguments_)) {
    return []
  }
  const value = (arguments_ as Record<string, unknown>)[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function urlHost(value: string | undefined): string {
  if (!value) {
    return ''
  }
  try {
    return ` ${new URL(value).hostname}`
  } catch {
    return ''
  }
}

function preview(value: string, maxLength: number): string {
  const normalized = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

function safeToolName(value: string): string {
  return preview(value, 48) || '未知工具'
}

function isToolEvent(data: unknown): data is {
  callId?: string
  toolName: string
  durationMs?: number
  error?: unknown
  arguments?: unknown
} {
  return Boolean(
    data && typeof data === 'object' && 'toolName' in data && typeof data.toolName === 'string',
  )
}

function isVerificationEvent(data: unknown): data is {
  status?: string
  passed?: boolean
  message?: string
} {
  return Boolean(data && typeof data === 'object')
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return 'tool execution failed'
}
