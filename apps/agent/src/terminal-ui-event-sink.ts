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
    return 'Thinking'
  }
  if (type === 'tool.started' && isToolEvent(data)) {
    return toolStatus(data.toolName)
  }
  if (type.includes('verification')) {
    return type.endsWith('.failed') ? 'Failed' : 'Verifying'
  }
  if (type.includes('tool')) {
    return type.endsWith('.failed') ? 'Failed' : 'Using tools'
  }
  if (type.endsWith('.failed')) {
    return 'Failed'
  }
  if (type.endsWith('.completed')) {
    return 'Completed'
  }
  if (type.endsWith('.started') || type.endsWith('.requested')) {
    return 'Running'
  }
  return 'Working'
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
    case 'edit_file':
      return '正在修改文件'
    case 'write_file':
      return '正在写入文件'
    case 'subagent':
      return '正在委派子 Agent'
    default:
      return `正在调用工具 ${safeToolName(toolName)}`
  }
}

export function summarizeEvent(type: string, data?: unknown): string {
  if (type === 'model.text_delta') {
    return ''
  }
  if (type === 'model.requested') {
    return '◌ Thinking…'
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
    case 'edit_file':
      return `正在修改文件${path ? ` ${path}` : ''}`
    case 'write_file':
      return `正在写入文件${path ? ` ${path}` : ''}`
    case 'subagent':
      return '正在委派子 Agent 分析任务'
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
    case 'edit_file':
      return `已修改文件${path ? ` ${path}` : ''}`
    case 'write_file':
      return `已写入文件${path ? ` ${path}` : ''}`
    case 'subagent':
      return '子 Agent 分析完成'
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
    case 'edit_file':
      return `修改文件失败${path ? ` ${path}` : ''}`
    case 'write_file':
      return `写入文件失败${path ? ` ${path}` : ''}`
    case 'subagent':
      return '子 Agent 分析失败'
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
