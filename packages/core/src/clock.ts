export interface Clock {
  now(): Date
  monotonicMs(): number
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }

  monotonicMs(): number {
    return performance.now()
  }
}

export class FakeClock implements Clock {
  private current: Date
  private mono: number

  constructor(start = new Date('2026-01-01T00:00:00.000Z'), mono = 0) {
    this.current = start
    this.mono = mono
  }

  now(): Date {
    return new Date(this.current.getTime())
  }

  monotonicMs(): number {
    return this.mono
  }

  advance(ms: number): void {
    this.mono += ms
    this.current = new Date(this.current.getTime() + ms)
  }
}
