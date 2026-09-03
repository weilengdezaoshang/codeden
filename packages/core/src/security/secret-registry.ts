import type { ResolvedSecret } from './resolved-secret.js'

export interface SecretRegistry {
  register(secret: ResolvedSecret): void
  redact(text: string): string
  containsSecret(text: string): boolean
}

export class InMemorySecretRegistry implements SecretRegistry {
  private readonly secrets: ResolvedSecret[] = []

  register(secret: ResolvedSecret): void {
    this.secrets.push(secret)
  }

  redact(text: string): string {
    return this.secrets.reduce((current, secret) => secret.redactFrom(current), text)
  }

  containsSecret(text: string): boolean {
    return this.secrets.some((secret) => secret.matches(text))
  }
}
