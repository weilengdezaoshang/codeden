import { StringDecoder } from 'node:string_decoder'
import type { Key } from 'node:readline'
import { toolPermissionPrompt } from './terminal-ui-event-sink.js'

export interface UiFileChange {
  path: string
  diff: string
}
export interface UiMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  activity?: boolean
  collapsed?: boolean
  activityKey?: string
}
export interface TerminalUiOptions {
  onSubmit: (input: string) => Promise<void>
  onExit?: () => Promise<void> | void
  onCancel?: () => Promise<void> | void
}

export const INTERACTIVE_COMMANDS = [
  '/help',
  '/status',
  '/context',
  '/history',
  '/sessions',
  '/resume',
  '/new',
  '/delete',
  '/cost',
  '/plan',
  '/permission',
  '/persona',
  '/memory',
  '/skills',
  '/skill',
  '/fold',
  '/compact',
  '/diff',
  '/apply',
  '/discard',
  '/clear',
  '/exit',
] as const

export interface HeaderUsageStats {
  inputTokens: number
  outputTokens: number
  turnCount: number
}
export type TerminalHeaderState = 'idle' | 'running' | 'waiting'

/** Grok Build 风格的全屏终端 UI：固定头尾，中间显示可滚动的 Agent 活动。 */
export class TerminalUi {
  private readonly messages: UiMessage[] = []
  private readonly files: UiFileChange[] = []
  private active = false
  private submitting = false
  private status = 'Idle'
  private inputBuffer = ''
  private inputCursor = 0
  private streaming = false
  private streamCompleted = false
  private streamMessageIndex: number | undefined
  private streamTarget = ''
  private streamDisplayed = ''
  private streamTimer: ReturnType<typeof setTimeout> | undefined
  private linePending = false
  private scrollOffset = Number.MAX_SAFE_INTEGER
  private renderTimer: ReturnType<typeof setTimeout> | undefined
  private renderScheduled = false
  private dirty = false
  private rendering = false
  private canvasInitialized = false
  private confirmation:
    { prompt: string; resolve: (allowed: boolean) => void; abortSignal?: AbortSignal } | undefined
  private question:
    | {
        prompt: string
        options: readonly string[]
        resolve: (answer: string | undefined) => void
        abortSignal?: AbortSignal
        onAbort?: () => void
      }
    | undefined
  private rawInputBuffer = ''
  private readonly inputDecoder = new StringDecoder('utf8')
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  private usage: HeaderUsageStats = { inputTokens: 0, outputTokens: 0, turnCount: 0 }

  constructor(private readonly options: TerminalUiOptions) {}

  addMessage(message: UiMessage): void {
    this.messages.push(message)
    this.render()
  }

  upsertActivity(activityKey: string, content: string): void {
    const existing = [...this.messages]
      .reverse()
      .find((message) => message.activityKey === activityKey)
    if (existing) {
      existing.content = content
      existing.collapsed = false
    } else {
      this.messages.push({ role: 'tool', content, activity: true, activityKey })
    }
    this.render()
  }

  clearMessages(): void {
    this.messages.splice(0, this.messages.length)
    this.scrollOffset = Number.MAX_SAFE_INTEGER
    this.render()
  }

  appendAssistantDelta(delta: string): void {
    if (!delta) {
      return
    }
    if (!this.streaming || this.streamMessageIndex === undefined) {
      this.beginAssistantStream()
    }
    const streamMessageIndex = this.streamMessageIndex
    if (streamMessageIndex === undefined) {
      return
    }
    const message = this.messages[streamMessageIndex]
    if (!message) {
      return
    }
    message.content += delta
    this.streamTarget += delta
    this.pumpStream()
    this.render()
  }

  beginAssistantStream(): void {
    this.flushStream()
    this.streaming = true
    this.streamCompleted = false
    this.streamTarget = ''
    this.streamDisplayed = ''
    this.messages.push({ role: 'assistant', content: '' })
    this.streamMessageIndex = this.messages.length - 1
    this.render()
  }

  finishAssistantStream(): void {
    this.streamCompleted = true
    this.pumpStream()
  }

  setFileChanges(files: UiFileChange[]): void {
    this.files.splice(0, this.files.length, ...files)
    this.render()
  }

  setStatus(status: string): void {
    this.status = status.trim() || 'Idle'
    this.render()
  }

  /** 同步真实会话用量（token/轮数），供顶栏展示；由调用方在轮次完成后刷新。 */
  setUsage(usage: HeaderUsageStats): void {
    this.usage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      turnCount: usage.turnCount,
    }
    this.render()
  }

  async confirm(
    toolName: string,
    arguments_: unknown,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    return this.confirmPrompt(
      `${toolPermissionPrompt(toolName, arguments_)}。按 y 允许，按 n 或 Enter 拒绝`,
      abortSignal,
    )
  }

  async confirmAction(prompt: string, abortSignal?: AbortSignal): Promise<boolean> {
    const safePrompt = prompt
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 240)
    return this.confirmPrompt(`${safePrompt}。按 y 确认，按 n 或 Enter 取消`, abortSignal)
  }

  async ask(
    prompt: string,
    options: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!this.active || abortSignal?.aborted) {
      return undefined
    }
    const safePrompt = prompt
      .replace(/[^\S\r\n]+/gu, ' ')
      .trim()
      .slice(0, 240)
    const safeOptions = options.map((option) =>
      option
        .replace(/[^\S\r\n]+/gu, ' ')
        .trim()
        .slice(0, 120),
    )
    this.setStatus('等待用户选择')
    return new Promise((resolve) => {
      const onAbort = () => this.finishQuestion(undefined)
      this.question = { prompt: safePrompt, options: safeOptions, resolve, abortSignal, onAbort }
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      this.render()
    })
  }

  private async confirmPrompt(prompt: string, abortSignal?: AbortSignal): Promise<boolean> {
    if (!this.active || abortSignal?.aborted) {
      return false
    }
    this.setStatus('等待权限确认')
    return new Promise((resolve) => {
      this.confirmation = {
        prompt,
        resolve,
        abortSignal,
      }
      const onAbort = () => this.finishConfirmation(false)
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      this.render()
    })
  }

  start(): void {
    if (this.active) {
      return
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Interactive terminal UI requires a TTY')
    }
    this.active = true
    this.canvasInitialized = false
    process.stdin.resume()
    process.stdin.setRawMode(true)
    process.stdin.on('data', this.onInputData)
    process.stdout.write('\x1b[?1000h\x1b[?1006h')
    this.render()
  }

  async stop(): Promise<void> {
    if (!this.active) {
      return
    }
    this.active = false
    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
    }
    this.renderTimer = undefined
    this.renderScheduled = false
    if (this.streamTimer) {
      clearTimeout(this.streamTimer)
    }
    this.streamTimer = undefined
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer)
    }
    this.escapeTimer = undefined
    this.rawInputBuffer = ''
    this.streaming = false
    this.confirmation?.resolve(false)
    this.confirmation = undefined
    this.finishQuestion(undefined)
    process.stdin.off('data', this.onInputData)
    process.stdout.write('\x1b[?1000l\x1b[?1006l')
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25h\n')
    await this.options.onExit?.()
  }

  private readonly onKeypress = async (_value: string, key: Key): Promise<void> => {
    if (this.confirmation) {
      const confirmationInput = _value.toLowerCase()
      if (key.name === 'y' || confirmationInput === 'y') {
        return this.finishConfirmation(true)
      }
      if (
        key.name === 'n' ||
        confirmationInput === 'n' ||
        key.name === 'return' ||
        key.name === 'escape'
      ) {
        return this.finishConfirmation(false)
      }
      return
    }
    if (this.question) {
      if (key.name === 'escape' || key.name === 'return') {
        return this.finishQuestion(undefined)
      }
      const selected = Number(_value)
      if (Number.isInteger(selected) && selected >= 1 && selected <= this.question.options.length) {
        return this.finishQuestion(this.question.options[selected - 1])
      }
      return
    }
    if ((key.name === 'c' && key.ctrl) || key.name === 'escape' || _value === '\x1b') {
      if (this.submitting) {
        await this.options.onCancel?.()
      } else {
        await this.stop()
      }
      return
    }
    if (!this.active || this.submitting) {
      return
    }
    if (key.name === 'o' && key.ctrl) {
      this.toggleLastActivity()
      return
    }
    if (key.name === 'return') {
      const input = this.inputBuffer.trim()
      this.inputBuffer = ''
      this.inputCursor = 0
      if (!input) {
        return this.render()
      }
      this.linePending = true
      this.submitting = true
      try {
        await this.options.onSubmit(input)
      } finally {
        this.submitting = false
        this.linePending = false
        this.render()
      }
      return
    }
    if (key.name === 'backspace') {
      if (this.inputCursor > 0) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.inputCursor - 1) + this.inputBuffer.slice(this.inputCursor)
        this.inputCursor -= 1
        this.render()
      }
      return
    }
    if (key.name === 'left') {
      this.inputCursor = Math.max(0, this.inputCursor - 1)
      this.render()
      return
    }
    if (key.name === 'right') {
      this.inputCursor = Math.min(this.inputBuffer.length, this.inputCursor + 1)
      this.render()
      return
    }
    if (key.name === 'up' || key.name === 'pageup') {
      const amount = key.name === 'pageup' ? 8 : 1
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset === Number.MAX_SAFE_INTEGER ? 0 : this.scrollOffset - amount,
      )
      this.render()
      return
    }
    if (key.name === 'down' || key.name === 'pagedown') {
      const amount = key.name === 'pagedown' ? 8 : 1
      this.scrollOffset =
        this.scrollOffset === Number.MAX_SAFE_INTEGER
          ? Number.MAX_SAFE_INTEGER
          : this.scrollOffset + amount
      this.render()
      return
    }
    if (
      _value &&
      !/\d+;\d+(?:;\d+)?[Mm]/u.test(_value) &&
      !(key.name === undefined && /\d+;/.test(_value)) &&
      !_value.includes('\x1b') &&
      !/;[0-9]+[Mm]$/u.test(_value) &&
      !key.ctrl &&
      !key.meta
    ) {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.inputCursor) +
        _value +
        this.inputBuffer.slice(this.inputCursor)
      this.inputCursor += _value.length
      this.render()
    }
  }

  /** 统一消费 raw stdin，保证鼠标序列不会再进入文字输入处理。 */
  private readonly onInputData = (chunk: Buffer | string): void => {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer)
      this.escapeTimer = undefined
    }
    this.rawInputBuffer += this.inputDecoder.write(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    )
    this.consumeInputBuffer()
  }

  private consumeInputBuffer(): void {
    while (this.rawInputBuffer.length > 0) {
      if (this.rawInputBuffer.startsWith('\x1b[<')) {
        // eslint-disable-next-line no-control-regex
        const mouse = this.rawInputBuffer.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/u)
        if (!mouse) {
          this.scheduleEscapeFlush()
          return
        }
        this.rawInputBuffer = this.rawInputBuffer.slice(mouse[0].length)
        this.handleMouseEvent(Number(mouse[1]))
        continue
      }

      if (this.rawInputBuffer.startsWith('\x1b[')) {
        // eslint-disable-next-line no-control-regex
        const keySequence = this.rawInputBuffer.match(/^\x1b\[[0-9;?]*[A-Za-z~]/u)
        if (!keySequence) {
          this.scheduleEscapeFlush()
          return
        }
        this.rawInputBuffer = this.rawInputBuffer.slice(keySequence[0].length)
        this.dispatchKeySequence(keySequence[0])
        continue
      }

      if (this.rawInputBuffer.startsWith('\x1b')) {
        this.rawInputBuffer = this.rawInputBuffer.slice(1)
        void this.onKeypress('\x1b', { name: 'escape' })
        continue
      }

      const first = this.rawInputBuffer.codePointAt(0)
      if (first === undefined) {
        return
      }
      const value = String.fromCodePoint(first)
      this.rawInputBuffer = this.rawInputBuffer.slice(value.length)
      if (first === 3) {
        void this.onKeypress('', { name: 'c', ctrl: true })
      } else if (first === 13 || first === 10) {
        void this.onKeypress('', { name: 'return' })
      } else if (first === 8 || first === 127) {
        void this.onKeypress('', { name: 'backspace' })
      } else if (first === 15) {
        void this.onKeypress('', { name: 'o', ctrl: true })
      } else if (first >= 32) {
        void this.onKeypress(value, { name: undefined })
      }
    }
  }

  private dispatchKeySequence(sequence: string): void {
    const keyBySequence: Record<string, string> = {
      '\x1b[A': 'up',
      '\x1b[B': 'down',
      '\x1b[C': 'right',
      '\x1b[D': 'left',
      '\x1b[5~': 'pageup',
      '\x1b[6~': 'pagedown',
    }
    const name = keyBySequence[sequence]
    if (name) {
      void this.onKeypress('', { name })
    }
  }

  private handleMouseEvent(button: number): void {
    if (button === 64) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset === Number.MAX_SAFE_INTEGER ? 0 : this.scrollOffset - 3,
      )
      this.render()
    } else if (button === 65) {
      this.scrollOffset =
        this.scrollOffset === Number.MAX_SAFE_INTEGER
          ? Number.MAX_SAFE_INTEGER
          : this.scrollOffset + 3
      this.render()
    }
    // 鼠标点击、释放和移动事件只影响终端交互，不产生文本输入。
  }

  private scheduleEscapeFlush(): void {
    if (this.escapeTimer) {
      return
    }
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined
      if (this.rawInputBuffer.startsWith('\x1b')) {
        this.rawInputBuffer = ''
        void this.onKeypress('\x1b', { name: 'escape' })
      }
    }, 50)
  }

  private finishConfirmation(allowed: boolean): void {
    const confirmation = this.confirmation
    if (!confirmation) {
      return
    }
    this.confirmation = undefined
    confirmation.resolve(allowed)
    this.render()
  }

  private finishQuestion(answer: string | undefined): void {
    const question = this.question
    if (!question) {
      return
    }
    if (question.onAbort) {
      question.abortSignal?.removeEventListener('abort', question.onAbort)
    }
    this.question = undefined
    question.resolve(answer)
    this.setStatus('Idle')
    this.render()
  }

  private pumpStream(): void {
    if (this.streamTimer || this.streamDisplayed.length >= this.streamTarget.length) {
      if (this.streamCompleted && this.streamDisplayed.length >= this.streamTarget.length) {
        this.streaming = false
        this.streamMessageIndex = undefined
      }
      return
    }
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined
      // 步长随剩余长度放大：长回复也在约 0.3s 内完成打字机展示，短回复保持逐字节奏。
      const pending = this.streamTarget.length - this.streamDisplayed.length
      const step = Math.max(1, Math.ceil(pending / 16))
      this.streamDisplayed += this.streamTarget.slice(
        this.streamDisplayed.length,
        this.streamDisplayed.length + step,
      )
      this.render()
      this.pumpStream()
    }, 18)
  }

  private flushStream(): void {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer)
    }
    this.streamTimer = undefined
    if (this.streamMessageIndex !== undefined) {
      const message = this.messages[this.streamMessageIndex]
      if (message) {
        message.content = this.streamTarget
      }
    }
    this.streamDisplayed = this.streamTarget
    this.streaming = false
    this.streamMessageIndex = undefined
  }

  private toggleLastActivity(): void {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]
      if (message?.activity) {
        message.collapsed = !message.collapsed
        this.render()
        return
      }
    }
  }

  private render(): void {
    this.dirty = true
    if (this.renderScheduled) {
      return
    }
    this.renderScheduled = true
    this.renderTimer = setTimeout(() => {
      this.renderScheduled = false
      this.renderTimer = undefined
      if (!this.dirty || this.rendering) {
        return
      }
      this.dirty = false
      this.rendering = true
      this.renderNow()
      this.rendering = false
      if (this.dirty) {
        this.render()
      }
    }, 40)
  }

  private renderNow(): void {
    if (!this.active || !process.stdout.isTTY) {
      return
    }
    const width = process.stdout.columns ?? 100
    const height = Math.max(12, process.stdout.rows ?? 24)
    const viewport = Math.max(1, height - 5)
    const hasConversation = this.messages.length > 0 || this.files.length > 0
    const lines = hasConversation
      ? this.messages.flatMap((message, index) => {
          const content = index === this.streamMessageIndex ? this.streamDisplayed : message.content
          return formatMessageForTerminal(message, content, width)
        })
      : renderHomeBanner(width, viewport)
    for (const file of this.files) {
      lines.push(`\x1b[36m▾ Diff\x1b[0m ${stripTerminalControlSequences(file.path)}`)
      lines.push(
        ...stripTerminalControlSequences(formatDiffForDisplay(file.diff))
          .split('\n')
          .map((line) => `  ${colorizeDiffLine(line)}`),
      )
    }
    const maxOffset = Math.max(0, lines.length - viewport)
    const offset =
      this.scrollOffset === Number.MAX_SAFE_INTEGER
        ? maxOffset
        : Math.min(this.scrollOffset, maxOffset)
    if (this.scrollOffset !== Number.MAX_SAFE_INTEGER && offset >= maxOffset) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER
    }
    const visible = lines.slice(offset, offset + viewport)
    const rows = new Map<number, string>()
    const headerState: TerminalHeaderState =
      this.confirmation || this.question ? 'waiting' : this.submitting ? 'running' : 'idle'
    rows.set(
      1,
      formatHeaderLine({ status: this.status, state: headerState, usage: this.usage }, width),
    )
    rows.set(2, `\x1b[90m${'─'.repeat(width)}\x1b[0m`)
    visible.forEach((line, index) => rows.set(index + 3, clipTerminalLine(line, width)))
    for (let row = 3 + visible.length; row <= height - 3; row += 1) {
      rows.set(row, '')
    }
    rows.set(height - 2, `\x1b[90m${'─'.repeat(width)}\x1b[0m`)
    rows.set(height - 1, this.renderInputLine())
    rows.set(height, `\x1b[90mCtrl+O 折叠活动 · ↑↓/滚轮 滚动 · Ctrl+C 取消/退出 · Esc 退出\x1b[0m`)
    const prefix = this.canvasInitialized ? '\x1b[?25l' : '\x1b[2J\x1b[3J\x1b[?25l'
    const canvas = [...rows.entries()].map(
      ([row, line]) => `\x1b[${row};1H\x1b[2K${clipTerminalLine(line, width)}`,
    )
    process.stdout.write(prefix + canvas.join(''))
    this.canvasInitialized = true
  }

  private renderInputLine(): string {
    if (this.confirmation) {
      return `\x1b[1;33m?\x1b[0m ${this.confirmation.prompt}`
    }
    if (this.question) {
      const options = this.question.options
        .map((option, index) => `${index + 1}) ${option}`)
        .join('  ')
      return `\x1b[1;33m?\x1b[0m ${this.question.prompt} \x1b[90m${options}\x1b[0m`
    }
    if (this.submitting) {
      const text = this.status === 'Idle' ? 'Agent 运行中' : this.status
      return `\x1b[33m⏺\x1b[0m ${text}\x1b[90m（Ctrl+C 取消）\x1b[0m`
    }
    if (!this.inputBuffer) {
      return `\x1b[36m›\x1b[0m \x1b[90m输入任务，/help 查看命令\x1b[0m`
    }
    return `\x1b[36m›\x1b[0m ${this.inputBuffer}\x1b[90m▏\x1b[0m`
  }
}

/** 首页 Banner 字形：统一 8 列宽、5 行高的块状字母，不依赖外部 figlet 工具。 */
const BANNER_GLYPHS: Record<string, readonly string[]> = {
  c: [' ██████ ', '██      ', '██      ', '██      ', ' ██████ '],
  o: [' ██████ ', '██    ██', '██    ██', '██    ██', ' ██████ '],
  d: ['      ██', '      ██', '██    ██', '██    ██', ' ██████ '],
  e: [' ██████ ', '██      ', '███████ ', '██      ', ' ██████ '],
  n: ['██    ██', '███   ██', '██ ██ ██', '██  ████', '██    ██'],
}

export function codedenBannerLines(): string[] {
  const glyphs = 'codeden'.split('').map((letter) => BANNER_GLYPHS[letter])
  return [0, 1, 2, 3, 4].map((row) =>
    glyphs
      .map((glyph) => glyph?.[row] ?? '')
      .join(' ')
      .trimEnd(),
  )
}

/** Grok Build 风格的首页：空会话时在视口居中展示 codeden 大字与命令提示。 */
export function renderHomeBanner(width: number, viewport: number): string[] {
  const safeWidth = Math.max(1, width)
  const banner = codedenBannerLines().map(
    (line) => `\x1b[1;36m${centerLine(line, safeWidth)}\x1b[0m`,
  )
  const tagline = `\x1b[90m${centerLine('CodeDen · 会话式编程 Agent', safeWidth)}\x1b[0m`
  const hints = `\x1b[90m${centerLine('/help 查看命令 · /new 新会话 · Ctrl+C 退出', safeWidth)}\x1b[0m`
  const block = [...banner, '', tagline, hints].map((line) => clipTerminalLine(line, safeWidth))
  const padding = Math.max(0, Math.floor((Math.max(1, viewport) - block.length) / 2))
  return [...Array.from({ length: padding }, () => ''), ...block]
}

function centerLine(line: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - stringWidth(line)) / 2))
  return `${' '.repeat(padding)}${line}`
}

export function completeCommand(line: string): [string[], string] {
  if (!line.startsWith('/')) {
    return [[], line]
  }
  const hits = INTERACTIVE_COMMANDS.filter((command) => command.startsWith(line))
  return [hits.length > 0 ? [...hits] : [], line]
}

export function rememberInput(history: readonly string[], value: string, limit = 100): string[] {
  const normalized = value.trim()
  if (!normalized || limit <= 0) {
    return [...history].slice(-Math.max(0, limit))
  }
  const deduped = [...history].filter((item) => item !== normalized)
  deduped.push(normalized)
  return deduped.slice(-limit)
}

export function maxTerminalScroll(totalLines: number, viewport: number): number {
  return Math.max(0, totalLines - Math.max(1, viewport))
}

export function wrapTerminalText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const lines: string[] = []
  for (const paragraph of value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const chars = Array.from(paragraph)
    if (chars.length === 0) {
      lines.push('')
      continue
    }
    let line = ''
    let lineWidth = 0
    for (const char of chars) {
      const charWidth = charDisplayWidth(char)
      if (lineWidth > 0 && lineWidth + charWidth > safeWidth) {
        lines.push(line)
        line = ''
        lineWidth = 0
      }
      line += char
      lineWidth += charWidth
    }
    lines.push(line)
  }
  return lines.length > 0 ? lines : ['']
}

/** 单字符的终端显示宽度：CJK/全角/emoji 记 2 列，其余记 1 列。 */
function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x20000
  ) {
    return 2
  }
  return 1
}

/** 可见显示宽度（先剥离 ANSI 控制序列），用于布局对齐与裁剪。 */
export function stringWidth(value: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, '')
  let total = 0
  for (const char of Array.from(plain)) {
    total += charDisplayWidth(char)
  }
  return total
}

/** 将助手正文按 Markdown 的文本块和 fenced code block 分开渲染。 */
export function formatMessageForTerminal(
  message: UiMessage,
  content: string,
  width: number,
): string[] {
  const safeContent = stripTerminalControlSequences(content)
  const safeWidth = Math.max(1, width - 6)
  if (message.activity) {
    const marker = message.collapsed ? '▸' : '▾'
    const wrapped = wrapLabeledText(`  ${marker} `, safeContent, safeWidth)
    return (message.collapsed ? wrapped.slice(0, 1) : wrapped).map(
      (line) => `\x1b[90m${line}\x1b[0m`,
    )
  }
  if (message.role === 'user') {
    return formatUserMessage(safeContent, safeWidth)
  }
  if (message.role !== 'assistant') {
    return wrapLabeledText('\x1b[90m·\x1b[0m ', safeContent, safeWidth)
  }
  return formatAssistantMarkdown(safeContent, safeWidth)
}

function formatAssistantMarkdown(content: string, width: number): string[] {
  const lines: string[] = []
  let inCode = false
  let language = ''
  const sourceLines = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')

  for (const sourceLine of sourceLines) {
    const fence = sourceLine.match(/^\s*```\s*([\w#+.-]*)\s*$/u)
    if (fence) {
      if (inCode) {
        lines.push('\x1b[90m  └─\x1b[0m')
        inCode = false
        language = ''
      } else {
        language = fence[1] ?? ''
        lines.push(`\x1b[90m  ┌─ code${language ? ` (${language})` : ''}\x1b[0m`)
        inCode = true
      }
      continue
    }

    if (inCode) {
      const codeLines = wrapTerminalText(sourceLine, Math.max(1, width - 5))
      for (const codeLine of codeLines) {
        lines.push(`\x1b[90m  │ ${codeLine}\x1b[0m`)
      }
      continue
    }

    lines.push(...formatMarkdownLine(sourceLine, width))
  }

  if (inCode) {
    lines.push('\x1b[90m  └─\x1b[0m')
  }
  return lines.length > 0 ? lines : ['']
}

/**
 * Render the small, high-value Markdown subset that is useful in a terminal.
 * Formatting is applied after wrapping so ANSI sequences never affect layout.
 */
function formatMarkdownLine(sourceLine: string, width: number): string[] {
  const heading = sourceLine.match(/^\s{0,3}(#{1,6})\s+(.+)$/u)
  if (heading) {
    // Markdown syntax is a structural marker, not visible content in the terminal.
    return wrapMarkdownSegments(heading[2] ?? '', width, '\x1b[1;32m', '\x1b[0m')
  }

  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(sourceLine)) {
    return [`\x1b[90m${'─'.repeat(Math.min(width, 48))}\x1b[0m`]
  }

  const quote = sourceLine.match(/^\s{0,3}>\s?(.*)$/u)
  if (quote) {
    return wrapMarkdownSegments(quote[1] ?? '', Math.max(1, width - 3)).map(
      (line) => `\x1b[90m│\x1b[0m ${line}`,
    )
  }

  const list = sourceLine.match(/^\s{0,3}([-*+]\s+|\d+[.)]\s+)(.*)$/u)
  if (list) {
    const rawMarker = list[1] ?? ''
    const marker =
      rawMarker.startsWith('-') || rawMarker.startsWith('*') || rawMarker.startsWith('+')
        ? '• '
        : rawMarker
    const wrapped = wrapMarkdownSegments(list[2] ?? '', Math.max(1, width - marker.length))
    return wrapped.map(
      (line, index) => `${index === 0 ? marker : ' '.repeat(marker.length)}${line}`,
    )
  }

  return wrapMarkdownSegments(sourceLine, width)
}

type MarkdownSegment = { text: string; prefix?: string; suffix?: string }

function wrapMarkdownSegments(
  value: string,
  width: number,
  outerPrefix = '',
  outerSuffix = '',
): string[] {
  const safeWidth = Math.max(1, width)
  const segments = parseInlineMarkdown(value)
  const lines: string[] = []
  let line = ''
  let visibleLength = 0

  const flush = () => {
    lines.push(`${outerPrefix}${line}${outerSuffix}`)
    line = ''
    visibleLength = 0
  }

  for (const segment of segments) {
    const chars = Array.from(segment.text)
    if (chars.length === 0) {
      continue
    }
    let needsPrefix = Boolean(segment.prefix)
    for (const char of chars) {
      if (visibleLength >= safeWidth) {
        flush()
      }
      if (needsPrefix && segment.prefix) {
        line += segment.prefix
        needsPrefix = false
      }
      line += char
      visibleLength += 1
      if (visibleLength >= safeWidth) {
        line += segment.suffix ?? ''
        flush()
        needsPrefix = Boolean(segment.prefix)
      }
    }
    if (segment.suffix && visibleLength > 0) {
      line += segment.suffix
    }
  }
  if (line || lines.length === 0) {
    flush()
  }
  return lines
}

function parseInlineMarkdown(value: string): MarkdownSegment[] {
  const tokenPattern =
    /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|(?<!\w)\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)/gu
  const segments: MarkdownSegment[] = []
  let cursor = 0
  for (const match of value.matchAll(tokenPattern)) {
    const start = match.index ?? cursor
    if (start > cursor) {
      segments.push({ text: value.slice(cursor, start) })
    }
    if (match[1] !== undefined) {
      segments.push({ text: match[1], prefix: '\x1b[36m', suffix: '\x1b[39m' })
    } else if (match[2] !== undefined) {
      segments.push({ text: match[2], prefix: '\x1b[4;36m', suffix: '\x1b[24;39m' })
    } else if (match[4] !== undefined || match[5] !== undefined) {
      segments.push({ text: match[4] ?? match[5] ?? '', prefix: '\x1b[1m', suffix: '\x1b[22m' })
    } else if (match[6] !== undefined) {
      segments.push({ text: match[6], prefix: '\x1b[9m', suffix: '\x1b[29m' })
    } else {
      segments.push({ text: match[7] ?? match[8] ?? '', prefix: '\x1b[3m', suffix: '\x1b[23m' })
    }
    cursor = start + match[0].length
  }
  if (cursor < value.length) {
    segments.push({ text: value.slice(cursor) })
  }
  return segments.length > 0 ? segments : [{ text: '' }]
}

function stripTerminalControlSequences(value: string): string {
  // Strip CSI, OSC, DCS, SOS, PM, APC and remaining C0 controls before writing untrusted text to stdout.
  /* eslint-disable no-control-regex */
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b(?:P|X|\^|_)[\s\S]*?(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\x1b[@-_]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  /* eslint-enable no-control-regex */
}

function formatUserMessage(content: string, width: number): string[] {
  const prefix = '▸ You: '
  const labelLength = '▸ You:'.length
  return wrapLabeledText(prefix, content, width).map((line, index) =>
    index === 0 ? `\x1b[1;36m▸ You:\x1b[0m${line.slice(labelLength)}` : line,
  )
}

function wrapLabeledText(prefix: string, content: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const labelWidth = stringWidth(prefix)
  const available = Math.max(1, safeWidth - labelWidth)
  const continuation = ' '.repeat(labelWidth)
  const sourceLines = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const result: string[] = []
  let first = true
  for (const sourceLine of sourceLines) {
    const wrapped = wrapTerminalText(sourceLine, available)
    for (const line of wrapped) {
      result.push(`${first ? prefix : continuation}${line}`)
      first = false
    }
  }
  return result.length > 0 ? result : [prefix]
}

function clipTerminalLine(line: string, width: number): string {
  const safeWidth = Math.max(1, width)
  // ANSI 颜色码不占终端宽度，不能直接对包含控制码的字符串使用 slice。
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/gu
  let result = ''
  let visibleLength = 0
  let cursor = 0
  const appendPlain = (plain: string): boolean => {
    for (const char of Array.from(plain)) {
      const charWidth = charDisplayWidth(char)
      if (visibleLength + charWidth > safeWidth) {
        return false
      }
      result += char
      visibleLength += charWidth
    }
    return true
  }
  for (const match of line.matchAll(ansi)) {
    const matchIndex = match.index ?? cursor
    if (!appendPlain(line.slice(cursor, matchIndex))) {
      return `${result}\x1b[0m`
    }
    if (visibleLength >= safeWidth) {
      return `${result}\x1b[0m`
    }
    result += match[0]
    cursor = matchIndex + match[0].length
  }
  appendPlain(line.slice(cursor))
  return result
}

export function formatDiffForDisplay(diff: string): string {
  return diff.length <= 500_000
    ? diff
    : `${diff.slice(0, 500_000)}\n… diff truncated after 500000 characters …`
}

/** 顶栏：品牌 + 状态点（绿=就绪 黄=运行 青=等待输入）+ 右侧真实会话用量。 */
export function formatHeaderLine(
  input: {
    status: string
    state: TerminalHeaderState
    usage: HeaderUsageStats
  },
  width: number,
): string {
  const statusText = input.status === 'Idle' ? '就绪' : input.status
  const dot =
    input.state === 'running'
      ? '\x1b[33m●\x1b[0m'
      : input.state === 'waiting'
        ? '\x1b[36m●\x1b[0m'
        : '\x1b[32m●\x1b[0m'
  const left = `\x1b[36m◆\x1b[0m \x1b[1mcodeden\x1b[0m \x1b[90m·\x1b[0m ${dot} ${statusText}`
  const right = `\x1b[90m↑${formatTokenCount(input.usage.inputTokens)} ↓${formatTokenCount(input.usage.outputTokens)} · ${input.usage.turnCount} 轮\x1b[0m`
  const padding = Math.max(2, width - stringWidth(left) - stringWidth(right))
  return clipTerminalLine(`${left}${' '.repeat(padding)}${right}`, width)
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0'
  }
  if (value < 1000) {
    return String(Math.round(value))
  }
  return `${(value / 1000).toFixed(1).replace(/\.0$/u, '')}k`
}

/** diff 行着色：+绿 / −红 / @@青 / 文件头暗灰。 */
export function colorizeDiffLine(line: string): string {
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ')
  ) {
    return `\x1b[90m${line}\x1b[0m`
  }
  if (line.startsWith('@@')) {
    return `\x1b[36m${line}\x1b[0m`
  }
  if (line.startsWith('+')) {
    return `\x1b[32m${line}\x1b[0m`
  }
  if (line.startsWith('-')) {
    return `\x1b[31m${line}\x1b[0m`
  }
  return line
}
