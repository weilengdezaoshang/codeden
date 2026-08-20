import { inspect } from 'node:util'
import { CodeDenError } from '../core/errors/codeden-error.js'
import { ErrorCodes } from '../core/errors/error-codes.js'

export class ResolvedSecret {
  readonly #value: string

  constructor(value: string) {
    if (!value.trim()) {
      throw new CodeDenError({
        code: ErrorCodes.SECRET_ENV_NOT_FOUND,
        category: 'validation',
        message: 'Secret cannot be empty',
        retryable: false,
      })
    }
    this.#value = value
  }

  exposeForTransport(): string {
    return this.#value
  }

  matches(value: string): boolean {
    return value.includes(this.#value)
  }

  redactFrom(text: string): string {
    return text.split(this.#value).join('<redacted>')
  }

  toString(): string {
    return '<redacted>'
  }

  toJSON(): string {
    return '<redacted>'
  }

  [inspect.custom](): string {
    return '<redacted>'
  }
}
