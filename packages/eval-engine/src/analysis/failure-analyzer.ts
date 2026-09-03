import type { RunEvent } from '@codeden/core/events/run-event.js'
import type { TrialResult } from '../domain/trial-result.js'
import {
  fingerprintOutput,
  parseFailingIdentities,
} from '@codeden/agent-runtime/verification/failure-identity-parser.js'
import {
  toEvidenceRef,
  type FailureDiagnosis,
  type FailureEvidenceRef,
  type FailureLayer,
  type FailureStage,
} from '../domain/failure-diagnosis.js'

export type FailureCategory =
  'none' | 'infrastructure' | 'timeout' | 'budget' | 'submission' | 'verification' | 'agent'

export interface FailureAnalysis {
  readonly category: FailureCategory
  readonly message: string
  readonly identities: readonly string[]
  readonly fingerprint?: string
  readonly evidence: readonly string[]
  readonly diagnosis?: FailureDiagnosis
}

const MAX_EVIDENCE_CHARS = 4_000
const EVIDENCE_KEYS = new Set([
  'message',
  'evidence',
  'stdout',
  'stderr',
  'error',
  'text',
  'cause',
  'reason',
  'failure_reason',
  'output',
  'log',
  'details',
  'name',
])
const EVIDENCE_CONTAINER_KEYS = new Set(['graderResults'])

/** Produces deterministic failure attribution from persisted trial state and events. */
export function analyzeFailure(
  trial: TrialResult,
  events: readonly RunEvent[] = [],
): FailureAnalysis {
  const category = classify(trial)
  if (category === 'none') {
    return { category, message: 'Trial resolved successfully', identities: [], evidence: [] }
  }

  const evidenceItems = collectEvidence(events, category)
  const evidence = evidenceItems.map((item) => item.text)
  const joined = evidence.join('\n')
  const identities = parseFailingIdentities(joined)
  const diagnosis = diagnose(category, events)
  const evidenceRefs =
    evidenceItems.length > 0
      ? evidenceItems.map((item) => toEvidenceRef(item.event))
      : relevantEvents(events, category).slice(0, 8).map(toEvidenceRef)
  return {
    category,
    message: messageFor(category),
    identities,
    ...(joined ? { fingerprint: fingerprintOutput(joined) } : {}),
    evidence,
    diagnosis: {
      ...diagnosis,
      evidenceRefs: dedupeRefs(evidenceRefs).slice(0, 8),
    },
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

interface CollectedEvidence {
  readonly text: string
  readonly event: RunEvent
}

function collectEvidence(
  events: readonly RunEvent[],
  category: Exclude<FailureCategory, 'none'>,
): CollectedEvidence[] {
  const relevant = relevantEvents(events, category)
  if (category === 'submission') {
    return collectSubmissionEvidence(relevant)
  }
  const evidence: CollectedEvidence[] = []
  for (const event of relevant) {
    const values = extractStrings(event.data)
    for (const value of values) {
      const clipped = clip(value)
      if (clipped && !evidence.some((item) => item.text === clipped)) {
        evidence.push({ text: clipped, event })
      }
      if (evidence.length >= 8) {
        return evidence
      }
    }
  }
  return evidence
}

function collectSubmissionEvidence(events: readonly RunEvent[]): CollectedEvidence[] {
  const evidence: CollectedEvidence[] = []
  const toolCalls = events.filter((event) => event.type === 'tool.started')
  const failedTools = events.filter((event) => event.type === 'tool.failed')
  const writeTools = toolCalls.filter((event) => {
    const data =
      event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {}
    return data.toolName === 'edit_file' || data.toolName === 'write_file'
  })
  const submitted = events.filter((event) => event.type === 'agent.submitted').at(-1)

  if (toolCalls.length === 0) {
    evidence.push({
      text: '未发现工具调用：Agent 可能只输出了分析，没有执行文件编辑。',
      event: events[0] ?? { ...emptyDiagnosticEvent(), sequence: 0 },
    })
  } else {
    evidence.push({ text: `共执行 ${toolCalls.length} 次工具调用。`, event: toolCalls.at(-1)! })
    evidence.push({
      text: writeTools.length
        ? `发现 ${writeTools.length} 次文件写入工具调用，但最终仍未检测到 Git diff。`
        : '未发现 edit_file 或 write_file 调用：这些工具调用可能都是读取、搜索或其他非写入操作。',
      event: toolCalls.at(-1)!,
    })
  }
  for (const event of failedTools.slice(-3)) {
    const data =
      event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {}
    const tool = typeof data.toolName === 'string' ? data.toolName : '未知工具'
    const error =
      typeof data.error === 'string'
        ? data.error
        : typeof data.message === 'string'
          ? data.message
          : '未提供错误详情'
    evidence.push({ text: `工具 ${tool} 失败：${clip(error)}`, event })
  }
  if (submitted) {
    const data =
      submitted.data && typeof submitted.data === 'object'
        ? (submitted.data as Record<string, unknown>)
        : {}
    const submission =
      data.submission && typeof data.submission === 'object'
        ? (data.submission as Record<string, unknown>)
        : {}
    const paths = Array.isArray(submission.changedPaths)
      ? submission.changedPaths.filter((path): path is string => typeof path === 'string')
      : []
    evidence.push({
      text: paths.length
        ? `提交文件：${paths.join('、')}`
        : '提交事件已产生，但 changedPaths 为空。',
      event: submitted,
    })
  }
  return evidence
}

function emptyDiagnosticEvent(): RunEvent {
  return {
    schemaVersion: 1,
    runId: '',
    trialId: '',
    sequence: 0,
    timestamp: new Date(0).toISOString(),
    source: 'eval',
    type: 'eval.trial.started',
    data: {},
  }
}

function isRelevant(event: RunEvent, category: Exclude<FailureCategory, 'none'>): boolean {
  if (category === 'verification') {
    return event.source === 'verifier'
  }
  if (category === 'infrastructure') {
    return event.source === 'workspace' || event.source === 'eval'
  }
  if (category === 'agent') {
    return event.source === 'agent' || event.source === 'model' || event.source === 'tool'
  }
  return event.source === 'agent' || event.source === 'model' || event.source === 'tool'
}

function relevantEvents(
  events: readonly RunEvent[],
  category: Exclude<FailureCategory, 'none'>,
): RunEvent[] {
  return events
    .filter((event) => isRelevant(event, category))
    .sort((left, right) => left.sequence - right.sequence)
}

function dedupeRefs(refs: readonly FailureEvidenceRef[]): FailureEvidenceRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.runId}:${ref.trialId}:${ref.sequence}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function diagnose(
  category: Exclude<FailureCategory, 'none'>,
  events: readonly RunEvent[],
): Omit<FailureDiagnosis, 'evidenceRefs'> {
  const relevant = relevantEvents(events, category)
  const direct =
    category === 'agent' || category === 'submission' ? findDirectCause(relevant) : undefined
  if (direct) {
    return direct
  }

  switch (category) {
    case 'infrastructure':
      return diagnosis(
        'infrastructure',
        'setup',
        '评测基础设施未能完成正常执行',
        '检查工作区创建、依赖安装和运行环境日志',
        0.98,
      )
    case 'timeout':
      return diagnosis(
        'runtime',
        'evaluation',
        'Agent 在执行时间预算内未完成任务',
        '检查最后一个模型或工具 Span，并适当调整任务拆分或超时配置',
        0.9,
      )
    case 'budget':
      return diagnosis(
        'runtime',
        'evaluation',
        'Agent 达到轮次或工具调用预算上限',
        '检查是否存在重复工具调用、上下文漂移或不必要的重试',
        0.96,
      )
    case 'submission':
      return diagnosis(
        'agent',
        'submission',
        'Agent 未生成可验证的有效提交',
        '检查最终响应和 agent.submitted 事件，确认完成协议是否被遵循',
        0.94,
      )
    case 'verification':
      if (hasHarnessInfrastructureSignature(relevant)) {
        return diagnosis(
          'infrastructure',
          'evaluation',
          'SWE-bench 官方测试环境未能启动，当前失败不是 Patch 内容导致的',
          '检查 Docker 镜像架构、镜像拉取和 Harness 容器日志；Apple Silicon 机器需要 amd64 镜像或启用架构兼容运行',
          0.99,
        )
      }
      return diagnosis(
        'verifier',
        'verification',
        '提交已生成，但未通过独立验证器',
        '根据验证证据定位失败测试，再判断是实现缺陷还是验证器配置问题',
        0.98,
      )
    case 'agent':
      return diagnosis(
        'agent',
        'unknown',
        'Agent 执行未能完成预期状态转换',
        '回看模型响应、工具结果和会话状态，补充缺失的阶段事件',
        0.65,
      )
  }
}

function hasHarnessInfrastructureSignature(events: readonly RunEvent[]) {
  const text = events.flatMap((event) => extractStrings(event.data)).join('\n')
  return /SWE-bench 官方 Harness|harness_execution|failure_reason=|infra_failure=|error_ids=|no matching manifest|linux\/arm64|no such image|Cannot connect to the Docker daemon|TLS handshake timeout|Error response from daemon|docker\.errors\.|requests\.exceptions\.|404 Client Error|Failed to prepare repository fixture/iu.test(
    text,
  )
}

function findDirectCause(
  events: readonly RunEvent[],
): Omit<FailureDiagnosis, 'evidenceRefs'> | undefined {
  const directFailure = events
    .filter(
      (event) =>
        (event.type === 'model.failed' || event.type === 'tool.failed') &&
        Boolean(
          event.data &&
          typeof event.data === 'object' &&
          'terminal' in event.data &&
          event.data.terminal === true &&
          (!('agentDepth' in event.data) || !event.data.agentDepth),
        ) &&
        !events.some(
          (later) =>
            later.sequence > event.sequence &&
            later.type === 'model.completed' &&
            Boolean(
              later.data &&
              typeof later.data === 'object' &&
              (!('agentDepth' in later.data) || !later.data.agentDepth),
            ),
        ),
    )
    .at(-1)
  if (directFailure?.type === 'model.failed') {
    return diagnosis(
      'model',
      'model_generation',
      '模型请求或响应生成失败',
      '检查模型提供商错误、请求参数和重试策略',
      0.99,
    )
  }

  if (directFailure?.type === 'tool.failed') {
    return diagnosis(
      'tool',
      'tool_execution',
      '工具调用失败并阻断了后续执行',
      '检查工具输入、权限策略和工具返回的错误信息',
      0.99,
    )
  }

  return undefined
}

function diagnosis(
  layer: FailureLayer,
  stage: FailureStage,
  rootCause: string,
  suggestion: string,
  confidence: number,
): Omit<FailureDiagnosis, 'evidenceRefs'> {
  return { layer, stage, rootCause, suggestion, confidence }
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
    if (!isEvidenceKey(key) && !EVIDENCE_CONTAINER_KEYS.has(key)) {
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
