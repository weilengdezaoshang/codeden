import readline from 'node:readline'

export interface UiFileChange {
  path: string
  diff: string
}

export interface UiMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
}

export interface TerminalUiOptions {
  onSubmit: (input: string) => Promise<void>
  onExit?: () => Promise<void> | void
}

const MAX_DIFF_CHARS = 500_000
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g

/** Minimal dependency-free fullscreen TUI; Agent events update state through the public methods. */
export class TerminalUi {
  private readonly messages: UiMessage[] = []
  private readonly files: UiFileChange[] = []
  private fileIndex = 0
  private fileListScroll = 0
  private diffScroll = 0
  private messageScroll = 0
  private active = false
  private submitting = false
  private readingInput = false
  private focus: 'files' | 'messages' | 'diff' = 'files'
  private readonly onResize = () => this.render()
  private readonly onSignal = () => void this.stop()
  private readonly onExit = () => this.restoreTerminal()

  constructor(private readonly options: TerminalUiOptions) {}

  addMessage(message: UiMessage): void {
    this.messages.push(message)
    this.messageScroll = Number.MAX_SAFE_INTEGER
    this.render()
  }

  setFileChanges(files: UiFileChange[]): void {
    this.files.splice(0, this.files.length, ...files)
    this.fileIndex = Math.min(this.fileIndex, Math.max(0, this.files.length - 1))
    if (this.files.length === 0) {
      this.fileListScroll = 0
      this.diffScroll = 0
    }
    this.render()
  }

  start(): void {
    if (this.active) {
      return
    }
    this.active = true
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      this.active = false
      throw new Error('Interactive terminal UI requires a TTY')
    }
    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.on('keypress', this.onKeypress)
    process.stdout.on('resize', this.onResize)
    process.once('SIGINT', this.onSignal)
    process.once('SIGTERM', this.onSignal)
    process.once('exit', this.onExit)
    this.render()
  }

  async stop(): Promise<void> {
    if (!this.active) {
      return
    }
    this.active = false
    process.stdin.off('keypress', this.onKeypress)
    process.stdout.off('resize', this.onResize)
    process.off('SIGINT', this.onSignal)
    process.off('SIGTERM', this.onSignal)
    process.off('exit', this.onExit)
    this.restoreTerminal()
    await this.options.onExit?.()
  }

  private restoreTerminal(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdout.write('\x1b[?25h\x1b[0m\n')
  }

  private readonly onKeypress = async (value: string, key: readline.Key) => {
    if (key.name === 'c' && key.ctrl) {
      return this.stop()
    }
    if (key.name === 'escape') {
      return this.stop()
    }
    if (key.name === 'tab') {
      this.focus =
        this.focus === 'files' ? 'messages' : this.focus === 'messages' ? 'diff' : 'files'
      this.render()
      return
    }
    if (this.readingInput || this.submitting) {
      return
    }
    if (key.name === 'up') {
      if (this.focus === 'files') {
        this.fileIndex = Math.max(0, this.fileIndex - 1)
        this.keepFileVisible()
        this.diffScroll = 0
      } else if (this.focus === 'messages') {
        this.messageScroll = Math.max(0, this.messageScroll - 1)
      } else {
        this.diffScroll = Math.max(0, this.diffScroll - 1)
      }
      this.render()
      return
    }
    if (key.name === 'down') {
      if (this.focus === 'files') {
        this.fileIndex = Math.min(Math.max(0, this.files.length - 1), this.fileIndex + 1)
        this.keepFileVisible()
        this.diffScroll = 0
      } else if (this.focus === 'messages') {
        this.messageScroll = Math.min(this.maxMessageScroll(), this.messageScroll + 1)
      } else {
        this.diffScroll = Math.min(this.maxDiffScroll(), this.diffScroll + 1)
      }
      this.render()
      return
    }
    if (key.name === 'pageup') {
      if (this.focus === 'messages') {
        this.messageScroll = Math.max(0, this.messageScroll - 10)
      } else if (this.focus === 'diff') {
        this.diffScroll = Math.max(0, this.diffScroll - 10)
      } else {
        this.fileListScroll = Math.max(0, this.fileListScroll - 10)
      }
      this.render()
      return
    }
    if (key.name === 'pagedown') {
      if (this.focus === 'messages') {
        this.messageScroll = Math.min(this.maxMessageScroll(), this.messageScroll + 10)
      } else if (this.focus === 'diff') {
        this.diffScroll = Math.min(this.maxDiffScroll(), this.diffScroll + 10)
      } else {
        this.fileListScroll = Math.min(this.maxFileScroll(), this.fileListScroll + 10)
      }
      this.render()
      return
    }
    if (key.name === 'return') {
      if (this.submitting) {
        return
      }
      this.readingInput = true
      let input = ''
      try {
        input = await this.readLine()
      } finally {
        this.readingInput = false
      }
      if (input) {
        this.submitting = true
        try {
          await this.options.onSubmit(input)
        } finally {
          this.submitting = false
          this.render()
        }
      }
    }
  }

  private async readLine(): Promise<string> {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      return (await new Promise<string>((resolve) => rl.question('You › ', resolve))).trim()
    } finally {
      rl.close()
      if (this.active && process.stdin.isTTY) {
        process.stdin.setRawMode(true)
      }
    }
  }

  private render(): void {
    if (!this.active) {
      return
    }
    const height = Math.max(8, (process.stdout.rows ?? 24) - 4)
    const width = process.stdout.columns ?? 100
    const leftWidth = Math.max(24, Math.floor(width * 0.28))
    const rightWidth = Math.max(30, width - leftWidth - 3)
    const recent = this.messages.slice(this.messageScroll, this.messageScroll + height)
    const selected = this.files[this.fileIndex]
    this.keepFileVisible(height - 2)
    this.diffScroll = Math.min(this.maxDiffScroll(height - 2), this.diffScroll)
    const diffText = selected?.diff.slice(0, MAX_DIFF_CHARS) ?? ''
    const diffLines = diffText.split('\n').slice(this.diffScroll, this.diffScroll + height)
    const visibleFiles = this.files.slice(this.fileListScroll, this.fileListScroll + height)
    const left = [
      `Files (${this.files.length})`,
      ...visibleFiles.map((file, index) => {
        const actualIndex = index + this.fileListScroll
        return `${actualIndex === this.fileIndex ? '›' : ' '} ${file.path}`
      }),
    ]
    const right = [
      selected ? `Diff: ${selected.path}` : 'No file selected',
      ...recent.map((message) => `${message.role}: ${message.content}`),
      ...diffLines,
    ]
    const lines: string[] = [
      '\x1b[2J\x1b[H\x1b[?25l',
      'CodeDen  •  Interactive Session',
      '─'.repeat(width),
    ]
    for (let index = 0; index < height; index += 1) {
      const leftLine = cleanTerminalText(left[index] ?? '')
        .slice(0, leftWidth)
        .padEnd(leftWidth)
      const rightLine = cleanTerminalText(right[index] ?? '').slice(0, rightWidth)
      lines.push(`${leftLine} │ ${rightLine}`)
    }
    lines.push(
      '─'.repeat(width),
      this.submitting
        ? 'Agent running…  Esc exit'
        : `Tab focus: ${this.focus}  ↑↓ scroll  PgUp/PgDn page  Enter input  Esc exit`,
    )
    process.stdout.write(lines.join('\n'))
  }

  private maxDiffScroll(viewport = Math.max(1, (process.stdout.rows ?? 24) - 6)): number {
    const selected = this.files[this.fileIndex]
    return Math.max(0, (selected?.diff.split('\n').length ?? 0) - viewport)
  }

  private maxMessageScroll(viewport = Math.max(1, (process.stdout.rows ?? 24) - 6)): number {
    return Math.max(0, this.messages.length - viewport)
  }

  private maxFileScroll(viewport = Math.max(1, (process.stdout.rows ?? 24) - 6)): number {
    return Math.max(0, this.files.length - viewport)
  }

  private keepFileVisible(viewport = Math.max(1, (process.stdout.rows ?? 24) - 6)): void {
    if (this.fileIndex < this.fileListScroll) {
      this.fileListScroll = this.fileIndex
    }
    if (this.fileIndex >= this.fileListScroll + viewport) {
      this.fileListScroll = this.fileIndex - viewport + 1
    }
    this.fileListScroll = Math.max(
      0,
      Math.min(this.fileListScroll, Math.max(0, this.files.length - viewport)),
    )
  }
}

function cleanTerminalText(value: string): string {
  return (
    value
      .replace(ANSI_ESCAPE, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  )
}
