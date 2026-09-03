export const MAX_COMMAND_STREAM_CHARS = 64_000
export const MAX_EVIDENCE_CHARS = 4_000
export const MAX_FAILING_IDENTITIES = 20
export const MAX_MODEL_FEEDBACK_CHARS = 6_000

const MARKER = '\n...[truncated]...\n'

export function clipHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }
  const budget = Math.max(1, maxChars - MARKER.length)
  const head = Math.max(1, Math.ceil(budget * 0.4))
  const tail = Math.max(1, budget - head)
  return `${text.slice(0, head)}${MARKER}${text.slice(-tail)}`
}

export function createBoundedBuffer(maxChars = MAX_COMMAND_STREAM_CHARS) {
  const half = Math.max(1, Math.floor(maxChars / 2))
  let head = ''
  let tail = ''
  let truncated = false

  return {
    push(chunk: string) {
      if (!truncated) {
        head += chunk
        if (head.length > maxChars) {
          truncated = true
          tail = head.slice(-half)
          head = head.slice(0, half)
        }
        return
      }
      tail = `${tail}${chunk}`.slice(-half)
    },
    toString() {
      return truncated ? `${head}${MARKER}${tail}` : head
    },
  }
}

export function capIdentities(items: string[], max = MAX_FAILING_IDENTITIES): string[] {
  if (items.length <= max) {
    return items
  }
  return [...items.slice(0, max), `...and ${items.length - max} more`]
}

export function clipEvidence(items: string[], maxChars = MAX_EVIDENCE_CHARS): string[] {
  return capIdentities(items).map((item) => clipHeadTail(item, maxChars))
}
