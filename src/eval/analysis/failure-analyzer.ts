import type { RunEvent } from '../../core/events/run-event.js'
import type { TrialResult } from '../domain/trial-result.js'
import {
  fingerprintOutput,
  parseFailingIdentities,
} from '../../runtime/verification/failure-identity-parser.js'

export type FailureCategory =
  'none' | 'infrastructure' | 'timeout' | 'budget' | 'submission' | 'verification' | 'agent'

export interface FailureAnalysis {
  readonly category: FailureCategory
  readonly message: string
  readonly identities: readonly string[]
  readonly fingerprint?: string
  readonly evidence: readonly string[]
}

const MAX_EVIDENCE_CHARS = 4_000
const EVIDENCE_KEYS = new Set(['message', 'evidence', 'stdout', 'stderr', 'error', 'text'])

/** Produces deterministic failure attribution from persisted trial state and events. */
export function analyzeFailure(
  trial: TrialResult,
  events: readonly RunEvent[] = [],
): FailureAnalysis {
  const category = classify(trial)
  if (category === 'none') {
    return { category, message: 'Trial resolved successfully', identities: [], evidence: [] }
  }

  const evidence = collectEvidence(events, category)
  const joined = evidence.join('\n')
  const identities = parseFailingIdentities(joined)
  return {
    category,
    message: messageFor(category),
    identities,
    ...(joined ? { fingerprint: fingerprintOutput(joined) } : {}),
    evidence,
  }
}

function classify(trial: TrialResult): FailureCategory {
  if (trial.resolved) {
    return 'none'
  }
  if (trial.infrastructure.status !== 'ok') {
    return 'infrastructure'
  }
  if (trial.execution.status === 'timeout') {
    return 'timeout'
  }
  if (trial.execution.status === 'budget_exhausted') {
    return 'budget'
  }
  if (trial.submission.status !== 'valid') {
    return 'submission'
  }
  if (trial.verification.status !== 'passed') {
    return 'verification'
  }
  return 'agent'
}

function messageFor(category: Exclude<FailureCategory, 'none'>): string {
  switch (category) {
    case 'infrastructure':
      return '评测基础设施执行失败'
    case 'timeout':
      return 'Agent 执行超时'
    case 'budget':
      return 'Agent 达到执行预算上限'
    case 'submission':
      return 'Agent 未生成有效提交'
    case 'verification':
      return '提交未通过验证器'
    case 'agent':
      return 'Agent 执行失败'
  }
}

function collectEvidence(
  events: readonly RunEvent[],
  category: Exclude<FailureCategory, 'none'>,
): string[] {
  const relevant = events.filter((event) => isRelevant(event, category))
  const evidence: string[] = []
  for (const event of relevant) {
    const values = extractStrings(event.data)
    for (const value of values) {
      const clipped = clip(value)
      if (clipped && !evidence.includes(clipped)) {
        evidence.push(clipped)
      }
      if (evidence.length >= 8) {
        return evidence
      }
    }
  }
  return evidence
}

function isRelevant(event: RunEvent, category: Exclude<FailureCategory, 'none'>): boolean {
  if (category === 'verification') {
    return event.source === 'verifier'
  }
  if (category === 'infrastructure') {
    return event.source === 'workspace' || event.source === 'eval'
  }
  if (category === 'agent') {
    return event.source === 'agent' || event.source === 'model'
  }
  return event.source === 'agent' || event.source === 'model' || event.source === 'tool'
}

function extractStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractStrings(item))
  }
  if (!value || typeof value !== 'object') {
    return []
  }
  return Object.entries(value).flatMap(([key, item]) => {
    if (!isEvidenceKey(key)) {
      return []
    }
    return extractStrings(item)
  })
}

function isEvidenceKey(key: string): boolean {
  return EVIDENCE_KEYS.has(key)
}

function clip(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length <= MAX_EVIDENCE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_EVIDENCE_CHARS)}…`
}
