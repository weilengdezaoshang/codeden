'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { type ReactNode } from 'react'
import { FileDiffList, type FileDiff } from './file-diff'
import {
  OverviewDashboard,
  type DashboardMatrixRow,
  type DashboardRunItem,
} from '../components/dashboard/overview-dashboard'
import { ResultStackBar } from '../components/charts/result-stack-bar'
import { DatasetSizeChart } from '../components/charts/dataset-size-chart'
import { MiniStack } from '../components/dashboard/mini-stack'

type View = 'overview' | 'datasets' | 'jobs'
type JobStatus =
  'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
type CatalogCase = { id: string; title: string; repository?: string; version?: string }
type Dataset = {
  id:
    | 'regression'
    | 'persona'
    | 'all'
    | 'swebench-lite'
    | 'swebench-verified'
    | 'swe-polybench'
    | 'terminal-bench'
    | 'humaneval'
  family: string
  name: string
  description: string
  count: number
  cases: CatalogCase[]
  license?: string
  version?: string
}
type Model = { id: 'mock' | 'configured'; name: string; synthetic: boolean }
type Catalog = { datasets: Dataset[]; models: Model[] }
type JobCase = {
  id: string
  goal: string
  prompt: string
  submissionType: 'files' | 'text'
}
type JobSummary = {
  totalCases: number
  passedCases: number
  failedCases: number
  passRate: number
  durationMs: number
  allResolved: boolean
  toolCalls?: number
  inputTokens?: number
  outputTokens?: number
  modelRequests?: number
  measuredTokenRequests?: number
  tokenUsageCoverage?: number
  p95LatencyMs?: number
  statisticsVersion?: string
  unknownCases?: number
  pendingCases?: number
  passShare?: number | null
  validSuccessRate?: number | null
  coverage?: number | null
  incomplete?: boolean
}
type Job = {
  id: string
  datasetId: Dataset['id']
  datasetName: string
  modelName: string
  synthetic: boolean
  caseCount: number
  repetitions: number
  status: JobStatus
  total: number
  completed: number
  createdAt: string
  finishedAt: string | null
  message: string | null
  summary: JobSummary | null
}
type BenchmarkRun = {
  benchmarkRunId: string
  jobId: string
  datasetId: Dataset['id']
  datasetName: string
  benchmarkType: string
  harnessType: string
  status: JobStatus
  total: number
  completed: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  summary: JobSummary | null
}
type Trial = {
  jobId?: string
  benchmarkRunId?: string
  runId?: string
  trialId: string
  caseId: string
  resolved: boolean
  execution: { status: string }
  submission: { status: string }
  verification: { status: string }
  infrastructure: { status: string }
  metrics: { durationMs: number; modelRequests: number; toolCalls: number }
  failure?: {
    category: string
    message: string
    evidence?: string[]
    diagnosis?: {
      layer: string
      stage: string
      rootCause: string
      suggestion: string
      confidence: number
    }
  }
  diffs?: FileDiff[]
}
type RunEvent = {
  eventId?: string
  jobId?: string
  benchmarkRunId?: string
  runId: string
  trialId: string
  sequence: number
  timestamp: string
  source: string
  type: string
  data: unknown
}
type JobProgress = {
  trialId: string
  caseId: string
  benchmarkRunId?: string
  events: RunEvent[]
}
type JobDetail = Job & {
  benchmarkRuns: BenchmarkRun[]
  cases: JobCase[]
  trials: Trial[]
  versions: { dataset: string; agent: string; grader: string; environment: string }
  progress: JobProgress | null
  progresses: JobProgress[]
  trialProgresses: JobProgress[]
}
type ProgressGroup = {
  id: string
  run: BenchmarkRun | null
  progresses: JobProgress[]
}

const statusLabels: Record<JobStatus, string> = {
  queued: '排队中',
  running: '执行中',
  cancelling: '取消中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}
const statusClasses: Record<JobStatus, string> = {
  queued: 'status-waiting',
  running: 'status-running',
  cancelling: 'status-waiting',
  completed: 'status-ready',
  failed: 'status-error',
  cancelled: 'status-muted',
  interrupted: 'status-error',
}

async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    cache: 'no-store',
  })
  const payload = (await response.json().catch(() => null)) as
    { error?: { message?: string } } | T | null
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? payload.error?.message
        : undefined
    throw new Error(message ?? `请求失败（${response.status}）`)
  }
  return payload as T
}

function formatDate(value: string | null) {
  if (!value) {
    return '—'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

function shortId(value: string, length = 8) {
  return value.length > length ? `${value.slice(0, length)}…` : value
}

const outcomeStatusLabels: Record<string, string> = {
  valid: '已生成补丁',
  empty: '未生成补丁',
  invalid: '补丁格式无效',
  missing: '未提交',
  passed: '验证通过',
  failed: '验证失败',
  error: '验证器异常',
  ok: '正常',
  agent_error: 'Agent 执行异常',
}

function outcomeStatus(value: string) {
  return outcomeStatusLabels[value] ?? value
}

const failureLayerLabels: Record<string, string> = {
  dataset: '评测数据',
  infrastructure: '基础设施',
  workspace: '工作区',
  prompt: '上下文',
  model: '模型',
  tool: '工具',
  runtime: '运行时',
  timeout: '运行时',
  budget: 'Agent 执行',
  submission: '提交',
  verification: '验证器',
  agent: 'Agent 执行',
  judge: '判卷器',
}
const failureStageLabels: Record<string, string> = {
  setup: '工作区准备',
  instruction_loading: '加载项目指令',
  prompt_composition: '构造 Agent 上下文',
  model_generation: '模型生成',
  tool_execution: '工具执行',
  submission: '提交',
  verification: '验证测试',
  evaluation: '评测执行',
  unknown: '未知阶段',
}

function failureLayer(trial: Trial) {
  if (trial.failure?.diagnosis?.layer) {
    return failureLayerLabels[trial.failure.diagnosis.layer] ?? trial.failure.diagnosis.layer
  }
  if (trial.failure?.category) {
    return failureLayerLabels[trial.failure.category] ?? trial.failure.category
  }
  if (trial.verification.status === 'error') {
    return '验证器'
  }
  if (trial.verification.status !== 'passed') {
    return '验证器'
  }
  return 'Agent 执行'
}

function eventData(event: RunEvent) {
  return event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {}
}

function eventLabel(event: RunEvent) {
  const data = eventData(event)
  const turn = typeof data.turn === 'number' ? ` · 第 ${data.turn} 轮` : ''
  const toolName = typeof data.toolName === 'string' ? ` · ${data.toolName}` : ''
  switch (event.type) {
    case 'eval.trial.started':
      return '开始执行题目'
    case 'workspace.prepared':
      return '准备隔离工作区'
    case 'agent.started':
      return '启动 Agent'
    case 'agent.instructions_loaded':
      return '加载项目指令'
    case 'agent.prompt_composed':
      return '准备 Agent 上下文'
    case 'model.requested':
      return `请求模型${turn}`
    case 'model.text_delta':
      return '模型输出中'
    case 'model.completed':
      return `模型响应完成${turn}`
    case 'tool.started':
      return `执行工具${toolName}`
    case 'tool.completed':
      return `工具执行完成${toolName}`
    case 'tool.failed':
      return `工具执行失败${toolName}`
    case 'agent.completion_proposed':
      return 'Agent 提交完成候选'
    case 'verification.started':
      return '开始验证修改'
    case 'verification.completed':
      return '验证完成'
    case 'verification.failed':
      return '验证失败，继续修复'
    case 'verification.stage': {
      const stage = eventData(event).name
      const status = eventData(event).status
      const label = typeof stage === 'string' ? (verificationStageLabels[stage] ?? stage) : '处理中'
      const statusLabel =
        typeof status === 'string' ? verificationStageStatusLabels[status] : undefined
      return `验证阶段 · ${label}${statusLabel ? ` · ${statusLabel}` : ''}`
    }
    case 'agent.submitted':
      return '提交评测结果'
    case 'agent.completed':
      return 'Agent 执行完成'
    case 'workspace.disposed':
      return '清理隔离工作区'
    case 'eval.trial.completed':
      return '题目执行完成'
    default:
      return event.type
  }
}

function latestEvent(events: RunEvent[], type: string) {
  return [...events].reverse().find((event) => event.type === type)
}

function eventKey(event: RunEvent) {
  return [
    event.jobId ?? '',
    event.benchmarkRunId ?? event.runId,
    event.trialId,
    event.sequence,
  ].join(':')
}

function mergeRunEvents(current: RunEvent[], incoming: RunEvent[]) {
  const merged = new Map(current.map((event) => [eventKey(event), event]))
  for (const event of incoming) {
    merged.set(eventKey(event), event)
  }
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence)
}

function trialKey(trial: Trial) {
  return [trial.benchmarkRunId ?? trial.runId ?? '', trial.trialId].join(':')
}

function progressKey(progress: JobProgress) {
  return [progress.benchmarkRunId ?? '', progress.trialId].join(':')
}

function progressCompleted(progress: JobProgress, events = progress.events) {
  return events.some((event) => event.type === 'eval.trial.completed')
}

function progressLatestEvent(progress: JobProgress, events = progress.events) {
  return events.at(-1) ?? progress.events.at(-1)
}

function diagnosticEvents(events: RunEvent[]) {
  return visibleTimelineEvents(
    events.filter(
      (event) =>
        event.type === 'tool.failed' ||
        event.type === 'verification.failed' ||
        event.type === 'verification.stage',
    ),
  )
}

const verificationStageLabels: Record<string, string> = {
  patch_generation: '生成 Patch',
  prediction_write: '写入 prediction 文件',
  harness_execution: '执行 SWE-bench Harness',
  report_read: '读取结果报告',
  result_classification: '判定验证结果',
}

const verificationStageStatusLabels: Record<string, string> = {
  started: '进行中',
  completed: '已完成',
  failed: '失败',
}

function visibleTimelineEvents(events: RunEvent[]) {
  // 时间线是不可变历史：started/completed/failed 都必须保留。
  // 阶段的“当前状态”应由单独的投影计算，不能在这里覆盖历史事件。
  return events
}

function evidenceTitle(value: string) {
  if (value.startsWith('未发现工具调用')) {
    return '工具调用'
  }
  if (value.startsWith('共执行')) {
    return '工具调用'
  }
  if (value.startsWith('工具 ')) {
    return '工具错误'
  }
  if (value.startsWith('提交文件') || value.startsWith('提交事件')) {
    return '提交结果'
  }
  return '诊断信息'
}

function verificationOutput(events: RunEvent[]): string[] {
  const output: string[] = []
  const keys = new Set([
    'message',
    'error',
    'cause',
    'reason',
    'failure_reason',
    'stdout',
    'stderr',
    'output',
    'log',
    'evidence',
    'graderResults',
  ])
  for (const event of events) {
    if (event.source !== 'verifier') {
      continue
    }
    const values = verifierStrings(event.data, keys)
    for (const value of values) {
      const clipped = value.length > 20_000 ? `…${value.slice(-20_000)}` : value
      const entry = `#${event.sequence} ${event.type}\n${clipped}`
      if (clipped.trim() && !output.includes(entry)) {
        output.push(entry)
      }
    }
  }
  return output
}

function verifierStrings(value: unknown, keys: ReadonlySet<string>): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => verifierStrings(item, keys))
  }
  if (!value || typeof value !== 'object') {
    return []
  }
  return Object.entries(value).flatMap(([key, item]) =>
    keys.has(key) ? verifierStrings(item, keys) : [],
  )
}

function renderAgentMarkdown(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/)
    if (fence) {
      const language = fence[1] ?? ''
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }
      blocks.push(
        <pre key={`code-${index}`}>
          <code className={language ? `language-${language}` : undefined}>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const Heading = `h${heading[1]?.length ?? 1}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(
        <Heading key={`heading-${index}`}>
          {renderInlineMarkdown(heading[2] ?? '', `heading-${index}`)}
        </Heading>,
      )
      index += 1
      continue
    }

    if (/^\s*(?:\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />)
      index += 1
      continue
    }

    const quoteLines: string[] = []
    while (index < lines.length) {
      const quote = (lines[index] ?? '').match(/^\s*>\s?(.*)$/)
      if (!quote) {
        break
      }
      quoteLines.push(quote[1] ?? '')
      index += 1
    }
    if (quoteLines.length > 0) {
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {renderInlineMarkdown(quoteLines.join('\n'), `quote-${index}`)}
        </blockquote>,
      )
      continue
    }

    const firstListItem = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/)
    if (firstListItem) {
      const ordered = /^\d/.test(firstListItem[1] ?? '')
      const items: ReactNode[] = []
      while (index < lines.length) {
        const item = (lines[index] ?? '').match(/^\s*([-+*]|\d+[.)])\s+(.+)$/)
        if (!item || /^\d/.test(item[1] ?? '') !== ordered) {
          break
        }
        items.push(
          <li key={`list-item-${index}`}>
            {renderInlineMarkdown(item[2] ?? '', `list-item-${index}`)}
          </li>,
        )
        index += 1
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={`list-${index}`}>{items}</List>)
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (
        !next.trim() ||
        /^\s*```/.test(next) ||
        /^\s*(?:#{1,6})\s+/.test(next) ||
        /^\s*>/.test(next) ||
        /^\s*(?:[-+*]|\d+[.)])\s+/.test(next)
      ) {
        break
      }
      paragraph.push(next)
      index += 1
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {renderInlineMarkdown(paragraph.join('\n'), `paragraph-${index}`)}
      </p>,
    )
  }

  return blocks
}

function renderInlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  const tokenPattern =
    /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_)/g
  const nodes: ReactNode[] = []
  let cursor = 0
  let tokenIndex = 0
  let match: RegExpExecArray | null

  const pushText = (text: string) => {
    const parts = text.split('\n')
    parts.forEach((part, index) => {
      if (part) {
        nodes.push(part)
      }
      if (index < parts.length - 1) {
        nodes.push(<br key={`${keyPrefix}-br-${tokenIndex++}`} />)
      }
    })
  }

  while ((match = tokenPattern.exec(value)) !== null) {
    pushText(value.slice(cursor, match.index))
    const key = `${keyPrefix}-inline-${tokenIndex++}`
    if (match[2] && match[3]) {
      nodes.push(
        <a key={key} href={match[3]} target="_blank" rel="noreferrer">
          {match[2]}
        </a>,
      )
    } else if (match[4]) {
      nodes.push(<code key={key}>{match[4]}</code>)
    } else if (match[5] || match[6]) {
      nodes.push(<strong key={key}>{match[5] ?? match[6]}</strong>)
    } else if (match[7]) {
      nodes.push(<del key={key}>{match[7]}</del>)
    } else if (match[8] || match[9]) {
      nodes.push(<em key={key}>{match[8] ?? match[9]}</em>)
    }
    cursor = match.index + match[0].length
  }
  pushText(value.slice(cursor))
  return nodes
}

function agentAnswer(events: RunEvent[]) {
  const proposed = latestEvent(events, 'agent.completion_proposed')
  const proposedText = proposed ? eventData(proposed).text : undefined
  if (typeof proposedText === 'string' && proposedText.trim()) {
    return proposedText.trim()
  }

  const submitted = latestEvent(events, 'agent.submitted')
  const submission = submitted ? eventData(submitted).submission : undefined
  if (submission && typeof submission === 'object') {
    const content = (submission as Record<string, unknown>).content
    if (typeof content === 'string' && content.trim()) {
      return content.trim()
    }
    const changedPaths = (submission as Record<string, unknown>).changedPaths
    if (Array.isArray(changedPaths) && changedPaths.every((item) => typeof item === 'string')) {
      return `提交文件：${changedPaths.join('、')}`
    }
  }
  return null
}

export default function Home() {
  const [view, setView] = useState<View>('overview')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [selectedTrialKey, setSelectedTrialKey] = useState<string | null>(null)
  const [datasetId, setDatasetId] = useState<Dataset['id']>('all')
  const [datasetIds, setDatasetIds] = useState<Dataset['id'][]>(['all'])
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([])
  const [modelId, setModelId] = useState<Model['id']>('mock')
  const [repetitions, setRepetitions] = useState(5)
  const [allowPaid, setAllowPaid] = useState(false)
  const [, setLoading] = useState(true)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [platformState, setPlatformState] = useState<'connecting' | 'online' | 'offline'>(
    'connecting',
  )
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [toastMessage, setToastMessage] = useState('')
  const [toastTone, setToastTone] = useState<'success' | 'error'>('success')
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([])

  const loadCatalog = useCallback(async () => {
    const value = await api<Catalog>('/api/catalog')
    setCatalog(value)
    setCatalogFailed(false)
    setPlatformState('online')
    if (!value.models.some((item) => item.id === modelId)) {
      setModelId(value.models[0]?.id ?? 'mock')
    }
    if (!value.datasets.some((item) => item.id === datasetId)) {
      setDatasetId(value.datasets[0]?.id ?? 'all')
    }
    setDatasetIds((current) => {
      const valid = current.filter((id) => value.datasets.some((item) => item.id === id))
      return valid.length ? valid : [value.datasets[0]?.id ?? 'all']
    })
  }, [datasetId, modelId])

  const retryCatalog = useCallback(async () => {
    setCatalogFailed(false)
    setError('')
    setLoading(true)
    try {
      await loadCatalog()
    } catch (reason: unknown) {
      setCatalogFailed(true)
      setPlatformState('offline')
      setError(reason instanceof Error ? reason.message : '无法读取评测目录。')
    } finally {
      setLoading(false)
    }
  }, [loadCatalog])

  useEffect(() => {
    if (datasetIds.length > 1) {
      setSelectedCaseIds((current) => (current.length === 0 ? current : []))
      return
    }
    const dataset = catalog?.datasets.find((item) => item.id === datasetId)
    if (dataset) {
      const nextCaseIds = dataset.cases.slice(0, 5).map((item) => item.id)
      setSelectedCaseIds((current) => {
        const unchanged =
          current.length === nextCaseIds.length &&
          current.every((caseId, index) => caseId === nextCaseIds[index])
        return unchanged ? current : nextCaseIds
      })
    }
  }, [catalog, datasetId, datasetIds.length])

  const loadJobs = useCallback(async () => {
    const value = await api<{ items: Job[] }>('/api/jobs?offset=0&limit=50')
    setJobs(value.items)
    setPlatformState('online')
    if (selectedJobId && !value.items.some((item) => item.id === selectedJobId)) {
      setSelectedJobId(null)
    } else if (!selectedJobId) {
      const active = value.items.find((item) =>
        ['queued', 'running', 'cancelling'].includes(item.status),
      )
      setSelectedJobId(active?.id ?? value.items[0]?.id ?? null)
    }
  }, [selectedJobId])

  const loadDetail = useCallback(async (id: string) => {
    const value = await api<JobDetail>(`/api/jobs/${id}`)
    setDetail((current) => {
      const active = ['queued', 'running', 'cancelling'].includes(value.status)
      if (!active || !current) {
        return value
      }
      return {
        ...value,
        progress: value.progress ?? current.progress,
        progresses: value.progresses.length ? value.progresses : current.progresses,
        trialProgresses: value.trialProgresses.length
          ? value.trialProgresses
          : current.trialProgresses,
      }
    })
    setJobs((current) => current.map((item) => (item.id === id ? value : item)))
  }, [])

  useEffect(() => {
    let active = true
    Promise.all([loadCatalog(), loadJobs()])
      .catch((reason: unknown) => {
        if (active) {
          setCatalogFailed(true)
          setPlatformState('offline')
          setError(reason instanceof Error ? reason.message : '无法连接评测平台。')
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [loadCatalog, loadJobs])

  useEffect(() => {
    if (!selectedJobId) {
      setDetail(null)
      return
    }
    let active = true
    const refresh = () => {
      void loadDetail(selectedJobId).catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : '无法读取任务详情。')
        }
      })
    }
    refresh()
    const timer = window.setInterval(
      refresh,
      detail?.status === 'queued' || detail?.status === 'running' || detail?.status === 'cancelling'
        ? 2_000
        : 10_000,
    )
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [detail?.status, loadDetail, selectedJobId])

  const selectedProgress = useMemo(
    () =>
      detail?.trialProgresses.find((item) => progressKey(item) === selectedTrialKey) ??
      detail?.trialProgresses[0] ??
      null,
    [detail, selectedTrialKey],
  )
  const selectedTrial = useMemo(() => {
    if (!detail) {
      return null
    }
    const explicit = selectedTrialKey
      ? detail.trials.find((item) => trialKey(item) === selectedTrialKey)
      : undefined
    if (explicit) {
      return explicit
    }
    if (selectedProgress) {
      return detail.trials.find((item) => trialKey(item) === progressKey(selectedProgress)) ?? null
    }
    return detail.trials[0] ?? null
  }, [detail, selectedProgress, selectedTrialKey])
  const activeJobs = jobs.filter((item) =>
    ['queued', 'running', 'cancelling'].includes(item.status),
  ).length

  async function createJob() {
    setError('')
    setNotice('')
    setCreating(true)
    try {
      const job = await api<Job>('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          requestId: globalThis.crypto.randomUUID(),
          datasetId,
          ...(datasetIds.length > 1 ? { datasetIds } : {}),
          ...(datasetIds.length === 1 ? { caseIds: selectedCaseIds } : {}),
          modelId,
          repetitions,
          allowPaid,
        }),
      })
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)])
      setSelectedJobId(job.id)
      setView('jobs')
      setNotice(`Job 已入队：${job.id}`)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : '创建评测失败。')
    } finally {
      setCreating(false)
    }
  }

  async function cancelJob() {
    if (!selectedJobId) {
      return
    }
    setError('')
    try {
      const job = await api<Job>(`/api/jobs/${selectedJobId}/cancel`, { method: 'POST' })
      setJobs((current) => current.map((item) => (item.id === job.id ? job : item)))
      setDetail((current) => (current ? { ...current, ...job } : current))
      setNotice('已请求取消 Job，Worker 会在下一个安全检查点停止。')
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : '取消评测失败。')
    }
  }

  async function deleteSelectedJobs(ids = selectedJobIds) {
    const targets = ids.filter((id) => {
      const job = jobs.find((item) => item.id === id)
      return job && !['queued', 'running', 'cancelling'].includes(job.status)
    })
    if (!targets.length || !window.confirm(`确定删除选中的 ${targets.length} 条实验记录？`)) {
      return
    }
    const results = await Promise.allSettled(
      targets.map((id) => api(`/api/jobs/${id}`, { method: 'DELETE' })),
    )
    const deleted = targets.filter((_, index) => results[index]?.status === 'fulfilled')
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length > 0 || deleted.length !== targets.length) {
      const reason = failed[0]?.reason
      const message = reason instanceof Error ? reason.message : '服务器返回 500，删除未完成。'
      setToastTone('error')
      setToastMessage(`删除失败：${message}`)
      window.setTimeout(() => setToastMessage(''), 4_000)
      return
    }
    setJobs((current) => current.filter((job) => !deleted.includes(job.id)))
    setSelectedJobIds([])
    if (selectedJobId && deleted.includes(selectedJobId)) {
      setSelectedJobId(null)
      setDetail(null)
    }
    await loadJobs()
    setNotice('')
    setToastTone('success')
    setToastMessage(`已删除 ${deleted.length} 条实验记录`)
    window.setTimeout(() => setToastMessage(''), 3000)
  }

  return (
    <div className="bench-app">
      <header className="bench-header">
        <a className="bench-brand" href="#overview" onClick={() => setView('overview')}>
          <span className="bench-brand-mark" aria-hidden="true">
            CD
          </span>
          <span>CodeDen</span>
        </a>
        <div className="bench-header-right">
          <span className={`bench-connection ${platformState === 'online' ? 'online' : 'offline'}`}>
            <span />{' '}
            {platformState === 'connecting'
              ? '连接中'
              : platformState === 'offline'
                ? '平台异常'
                : `Worker 任务队列 · ${activeJobs} 个执行中`}
          </span>
          <button
            className="bench-header-action"
            onClick={() => {
              setError('')
              void Promise.all([loadCatalog(), loadJobs()])
                .then(() => setNotice('已刷新评测平台数据。'))
                .catch((reason: unknown) => {
                  setPlatformState('offline')
                  setError(reason instanceof Error ? reason.message : '刷新失败。')
                })
            }}
          >
            刷新
          </button>
        </div>
      </header>

      <div className="bench-shell">
        <aside className="bench-sidebar">
          <nav className="bench-nav" aria-label="主导航">
            <button
              className={view === 'overview' ? 'active' : ''}
              onClick={() => setView('overview')}
            >
              总览
            </button>
            <button
              className={view === 'datasets' ? 'active' : ''}
              onClick={() => setView('datasets')}
            >
              评测集
            </button>
            <button className={view === 'jobs' ? 'active' : ''} onClick={() => setView('jobs')}>
              实验记录
            </button>
          </nav>
        </aside>

        <main className="bench-workspace">
          {error && (
            <div className="bench-notice error" role="alert">
              {error}
              <button onClick={() => setError('')}>关闭</button>
            </div>
          )}
          {notice && (
            <div className="bench-notice good" role="status">
              {notice}
            </div>
          )}
          {toastMessage && (
            <div className={`bench-toast ${toastTone === 'error' ? 'error' : ''}`} role="alert">
              {toastTone === 'error' ? '!' : '✓'} {toastMessage}
            </div>
          )}

          {view === 'overview' && (
            <OverviewView
              catalog={catalog}
              jobs={jobs}
              detail={detail}
              selectedJobId={selectedJobId}
              onSelectJob={(id) => {
                setSelectedJobId(id)
                setSelectedTrialKey(null)
              }}
              onOpenCreate={() => setView('datasets')}
              onOpenDetails={() => setView('jobs')}
            />
          )}
          {view === 'datasets' && (
            <DatasetView
              catalog={catalog}
              catalogFailed={catalogFailed}
              onRetryCatalog={() => void retryCatalog()}
              datasetId={datasetId}
              datasetIds={datasetIds}
              selectedCaseIds={selectedCaseIds}
              modelId={modelId}
              repetitions={repetitions}
              allowPaid={allowPaid}
              creating={creating}
              onDataset={(id) => {
                setDatasetId(id)
                setDatasetIds([id])
                setSelectedCaseIds(
                  catalog?.datasets
                    .find((item) => item.id === id)
                    ?.cases.slice(0, 5)
                    .map((item) => item.id) ?? [],
                )
              }}
              onDatasetIds={(ids) => {
                const next = ids.length ? ids : [datasetId]
                setDatasetIds(next)
                if (!next.includes(datasetId)) {
                  setDatasetId(next[0]!)
                }
                setSelectedCaseIds([])
              }}
              onCaseIds={setSelectedCaseIds}
              onModel={setModelId}
              onRepetitions={setRepetitions}
              onAllowPaid={setAllowPaid}
              onCreate={createJob}
            />
          )}
          {view === 'jobs' && (
            <JobsView
              jobs={jobs}
              detail={detail}
              selectedJobId={selectedJobId}
              selectedTrial={selectedTrial}
              selectedProgress={selectedProgress}
              onSelect={(id) => {
                setSelectedJobId(id)
                setSelectedTrialKey(null)
              }}
              onTrial={setSelectedTrialKey}
              onCancel={cancelJob}
              selectedJobIds={selectedJobIds}
              onSelectedJobIds={setSelectedJobIds}
              onDeleteSelected={deleteSelectedJobs}
              onCreate={() => setView('datasets')}
            />
          )}
        </main>
      </div>
    </div>
  )
}

type OverviewBucket = 'pass' | 'fail' | 'unknown'
type OverviewRow = {
  caseId: string
  prompt: string
  submissionType: 'files' | 'text'
  planned: number
  pass: number
  fail: number
  unknown: number
  latestTrial: Trial | null
  answer: string | null
  latestEvent: RunEvent | undefined
}

function overviewCaseId(caseId: string) {
  return caseId.replace(/#\d+$/u, '')
}

function overviewTrialBucket(trial: Trial): OverviewBucket {
  if (trial.resolved) {
    return 'pass'
  }
  if (
    trial.verification.status === 'error' ||
    trial.infrastructure.status !== 'ok' ||
    trial.execution.status === 'agent_error'
  ) {
    return 'unknown'
  }
  return 'fail'
}

function formatTokens(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`
  }
  return String(value)
}

/** 从 Job 摘要推导 P/F/U/M 四段计数；未执行的部分单列，不冒充失败。 */
function jobStackCounts(job: {
  total: number
  completed: number
  summary?: { totalCases?: number; passedCases?: number; failedCases?: number } | null
}) {
  const pass = job.summary?.passedCases ?? 0
  const fail = job.summary?.failedCases ?? 0
  const executed = job.summary?.totalCases ?? job.completed
  const unknown = Math.max(0, executed - pass - fail)
  return { pass, fail, unknown, pending: Math.max(0, job.total - executed) }
}

const dashboardStatusTone: Record<JobStatus, 'ok' | 'vol' | 'warn' | 'inc'> = {
  queued: 'warn',
  running: 'warn',
  cancelling: 'warn',
  completed: 'ok',
  failed: 'vol',
  cancelled: 'inc',
  interrupted: 'vol',
}
const dashboardRunStatus: Record<JobStatus, DashboardRunItem['status']> = {
  queued: 'queued',
  running: 'running',
  cancelling: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
  interrupted: 'stopped',
}

function OverviewView({
  catalog,
  jobs,
  detail,
  selectedJobId,
  onSelectJob,
  onOpenCreate,
  onOpenDetails,
}: {
  catalog: Catalog | null
  jobs: Job[]
  detail: JobDetail | null
  selectedJobId: string | null
  onSelectJob: (id: string) => void
  onOpenCreate: () => void
  onOpenDetails: () => void
}) {
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null)
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null
  const activeJobs = jobs.filter((job) => ['queued', 'running', 'cancelling'].includes(job.status))
  const detailIsCurrent = Boolean(detail && selectedJob && detail.id === selectedJob.id)
  const detailTrials = detailIsCurrent ? (detail?.trials ?? []) : []

  const rows = useMemo<OverviewRow[]>(() => {
    if (!detailIsCurrent || !detail) {
      return []
    }
    const caseMap = new Map<string, OverviewRow>()
    for (const spec of detail.cases) {
      const baseId = overviewCaseId(spec.id)
      if (caseMap.has(baseId)) {
        continue
      }
      caseMap.set(baseId, {
        caseId: baseId,
        prompt: spec.prompt,
        submissionType: spec.submissionType,
        planned: selectedJob?.repetitions ?? 1,
        pass: 0,
        fail: 0,
        unknown: 0,
        latestTrial: null,
        answer: null,
        latestEvent: undefined,
      })
    }
    for (const trial of detail.trials) {
      const baseId = overviewCaseId(trial.caseId)
      const spec = detail.cases.find((item) => overviewCaseId(item.id) === baseId)
      const row = caseMap.get(baseId) ?? {
        caseId: baseId,
        prompt: spec?.prompt ?? '未采集任务输入',
        submissionType: spec?.submissionType ?? 'text',
        planned: selectedJob?.repetitions ?? 1,
        pass: 0,
        fail: 0,
        unknown: 0,
        latestTrial: null,
        answer: null,
        latestEvent: undefined,
      }
      const bucket = overviewTrialBucket(trial)
      row[bucket] += 1
      const currentProgress = detail.trialProgresses.find(
        (progress) => progressKey(progress) === trialKey(trial),
      )
      const events = currentProgress?.events ?? []
      if (!row.latestTrial || trial.trialId > row.latestTrial.trialId) {
        row.latestTrial = trial
        row.answer = agentAnswer(events)
        row.latestEvent = events.at(-1)
      }
      caseMap.set(baseId, row)
    }
    return [...caseMap.values()].sort((left, right) => {
      const rank = (row: OverviewRow) => (row.fail > 0 ? 0 : row.unknown > 0 ? 1 : 2)
      return rank(left) - rank(right) || left.caseId.localeCompare(right.caseId)
    })
  }, [detail, detailIsCurrent, selectedJob?.repetitions])

  const counts = useMemo(() => {
    const planned = selectedJob?.total ?? 0
    const completed = detailIsCurrent ? detailTrials.length : (selectedJob?.completed ?? 0)
    const pass = detailIsCurrent
      ? detailTrials.filter((trial) => overviewTrialBucket(trial) === 'pass').length
      : (selectedJob?.summary?.passedCases ?? 0)
    const unknown = detailIsCurrent
      ? detailTrials.filter((trial) => overviewTrialBucket(trial) === 'unknown').length
      : (selectedJob?.summary?.unknownCases ?? 0)
    const fail = detailIsCurrent
      ? detailTrials.filter((trial) => overviewTrialBucket(trial) === 'fail').length
      : (selectedJob?.summary?.failedCases ?? 0)
    const pending = detailIsCurrent
      ? Math.max(0, planned - completed)
      : (selectedJob?.summary?.pendingCases ?? Math.max(0, planned - completed))
    return { planned, completed, pass, fail, unknown, pending }
  }, [detailIsCurrent, detailTrials, selectedJob])

  const passRate = counts.planned ? Math.round((counts.pass / counts.planned) * 100) : null
  const validRate =
    counts.pass + counts.fail ? Math.round((counts.pass / (counts.pass + counts.fail)) * 100) : null
  const coverage = counts.planned
    ? Math.round(((counts.pass + counts.fail) / counts.planned) * 100)
    : null

  const matrixRows = useMemo<DashboardMatrixRow[]>(
    () =>
      rows.map((row) => ({
        caseId: row.caseId,
        pass: row.pass,
        fail: row.fail,
        unknown: row.unknown,
        pending: Math.max(0, row.planned - row.pass - row.fail - row.unknown),
        submissionType: row.submissionType,
        answer: row.answer,
      })),
    [rows],
  )
  const rowMap = useMemo(() => new Map(rows.map((row) => [row.caseId, row])), [rows])

  const trend = useMemo(() => {
    if (!selectedJob) {
      return null
    }
    const values = jobs
      .filter(
        (job) =>
          job.datasetId === selectedJob.datasetId &&
          job.repetitions === selectedJob.repetitions &&
          job.summary &&
          job.summary.passedCases + job.summary.failedCases > 0,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-5)
      .map((job) => {
        const summary = job.summary!
        return Math.round((summary.passedCases / (summary.passedCases + summary.failedCases)) * 100)
      })
    if (values.length === 0) {
      return null
    }
    return {
      caption: `仅同条件运行（${selectedJob.datasetName} · ${selectedJob.repetitions} 次/题）`,
      values,
      note: '观测值，非稳定性承诺 · 分母为有效判定',
    }
  }, [jobs, selectedJob])

  const runs = useMemo<DashboardRunItem[]>(
    () =>
      jobs.slice(0, 5).map((job) => ({
        id: job.id,
        datasetName: job.datasetName,
        caption: `${job.modelName}${job.synthetic ? ' · Mock' : ''} · ${job.repetitions} 次/题 · ${formatDate(job.createdAt)}`,
        status: dashboardRunStatus[job.status],
        metric: job.summary
          ? `${Math.round(job.summary.passRate * 100)}%`
          : `${job.completed}/${job.total}`,
        stack: jobStackCounts(job),
        selected: job.id === selectedJob?.id,
      })),
    [jobs, selectedJob?.id],
  )

  const resources = useMemo(() => {
    const summary = detailIsCurrent ? (detail?.summary ?? null) : (selectedJob?.summary ?? null)
    const items: { label: string; value: string }[] = []
    if (summary?.durationMs) {
      items.push({ label: '墙钟', value: formatDuration(summary.durationMs) })
    }
    if (summary?.p95LatencyMs) {
      items.push({ label: 'p95 Trial 延迟', value: formatDuration(summary.p95LatencyMs) })
    }
    if (summary?.toolCalls) {
      items.push({ label: '工具调用', value: String(summary.toolCalls) })
    }
    if (summary?.inputTokens || summary?.outputTokens) {
      const coverageShare =
        summary.modelRequests && summary.measuredTokenRequests !== undefined
          ? Math.round((summary.measuredTokenRequests / summary.modelRequests) * 100)
          : null
      const tokenValue = `${formatTokens(summary.inputTokens ?? 0)} / ${formatTokens(summary.outputTokens ?? 0)}`
      items.push({
        label: 'Token 入/出',
        value:
          coverageShare === null ? tokenValue : `${tokenValue}（采集覆盖率 ${coverageShare}%）`,
      })
    }
    return items
  }, [detail, detailIsCurrent, selectedJob?.summary])

  const context = [
    {
      label: '数据集版本',
      value: detailIsCurrent ? shortId(detail?.versions.dataset ?? 'unavailable', 18) : '按需读取',
    },
    {
      label: 'Agent / 模型',
      value: `${selectedJob?.modelName ?? '—'}${selectedJob?.synthetic ? ' · Mock 流程验证' : ''}`,
    },
    {
      label: '重复模式',
      value:
        selectedJob?.repetitions === 1 ? '单次冒烟' : `${selectedJob?.repetitions ?? '—'} 次 / 题`,
    },
    {
      label: 'Token / 费用',
      value: resources.some((item) => item.label.includes('Token'))
        ? '见左侧资源行'
        : '未在当前摘要中采集',
    },
  ]

  if (!jobs.length) {
    return (
      <section className="overview-empty">
        <div className="overview-empty-mark">—</div>
        <h1>还没有评测运行</h1>
        <p>从已登记的评测集开始一次 Mock 评测，完成后这里会显示结果分布、案例矩阵和证据入口。</p>
        <button className="bench-primary" onClick={onOpenCreate}>
          新建评测
        </button>
      </section>
    )
  }

  return (
    <OverviewDashboard
      datasetName={selectedJob?.datasetName ?? '评测运行'}
      chips={[
        { label: `agent ${selectedJob?.modelName ?? '—'}` },
        {
          label: `${selectedJob?.caseCount ?? 0} 题 × ${selectedJob?.repetitions ?? 0} 次 = ${counts.planned} Trial`,
        },
        ...(selectedJob?.synthetic ? [{ label: 'Mock 仅验证流程' }] : []),
      ]}
      statusLabel={selectedJob ? statusLabels[selectedJob.status] : '—'}
      statusTone={selectedJob ? dashboardStatusTone[selectedJob.status] : 'inc'}
      metaLine={
        <>
          创建 {selectedJob ? formatDate(selectedJob.createdAt) : '—'} ·{' '}
          <code>{selectedJob ? shortId(selectedJob.id, 12) : '—'}</code>
          {catalog ? ` · ${catalog.datasets.length} 个可用评测集` : ''}
        </>
      }
      counts={counts}
      passRate={passRate}
      validRate={validRate}
      coverage={coverage}
      rows={matrixRows}
      loading={!detailIsCurrent}
      resources={resources}
      trend={trend}
      runs={runs}
      context={context}
      activeBanner={
        activeJobs.length > 0 ? { count: activeJobs.length, onClick: onOpenDetails } : undefined
      }
      onCreate={onOpenCreate}
      onOpenDetails={onOpenDetails}
      onSelectJob={onSelectJob}
      expandedCaseId={expandedCaseId}
      onToggleCase={(caseId) => setExpandedCaseId((prev) => (prev === caseId ? null : caseId))}
      renderRowDetail={(row) => {
        const original = rowMap.get(row.caseId)
        return original ? <OverviewRowDetail row={original} onOpenDetails={onOpenDetails} /> : null
      }}
    />
  )
}

function OverviewRowDetail({
  row,
  onOpenDetails,
}: {
  row: OverviewRow
  onOpenDetails: () => void
}) {
  return (
    <div className="overview-row-detail">
      <div>
        <span>任务输入</span>
        <p>{row.prompt}</p>
      </div>
      <div>
        <span>最新事件</span>
        <p>
          {row.latestEvent
            ? `${eventLabel(row.latestEvent)} · ${formatDate(row.latestEvent.timestamp)}`
            : '未采集事件'}
        </p>
      </div>
      <div>
        <span>试次</span>
        <p>
          <code>{row.latestTrial ? shortId(row.latestTrial.trialId, 18) : '—'}</code> · 共{' '}
          {row.planned} 次计划
        </p>
      </div>
      <button className="bench-secondary" onClick={onOpenDetails}>
        打开完整证据
      </button>
    </div>
  )
}

function DatasetView({
  catalog,
  catalogFailed,
  onRetryCatalog,
  datasetId,
  datasetIds,
  modelId,
  repetitions,
  allowPaid,
  creating,
  selectedCaseIds,
  onDataset,
  onDatasetIds,
  onCaseIds,
  onModel,
  onRepetitions,
  onAllowPaid,
  onCreate,
}: {
  catalog: Catalog | null
  catalogFailed: boolean
  onRetryCatalog: () => void
  datasetId: Dataset['id']
  datasetIds: Dataset['id'][]
  modelId: Model['id']
  repetitions: number
  allowPaid: boolean
  creating: boolean
  selectedCaseIds: string[]
  onDataset: (id: Dataset['id']) => void
  onDatasetIds: (ids: Dataset['id'][]) => void
  onCaseIds: (ids: string[]) => void
  onModel: (id: Model['id']) => void
  onRepetitions: (value: number) => void
  onAllowPaid: (value: boolean) => void
  onCreate: () => void
}) {
  const selectedDataset = catalog?.datasets.find((item) => item.id === datasetId)
  const selectedModel = catalog?.models.find((item) => item.id === modelId)
  const [caseSearch, setCaseSearch] = useState('')
  const visibleCases =
    selectedDataset?.cases.filter((item) =>
      `${item.id} ${item.title} ${item.repository ?? ''}`
        .toLowerCase()
        .includes(caseSearch.toLowerCase()),
    ) ?? []
  // 后端 caseIds 单次最多接受 20 道，全选时按上限截断。
  const planCaseCount =
    datasetIds.length > 1
      ? datasetIds.reduce(
          (sum, id) =>
            sum +
            (['swebench-lite', 'swe-polybench', 'terminal-bench'].includes(id)
              ? 1
              : (catalog?.datasets.find((item) => item.id === id)?.count ?? 0)),
          0,
        )
      : selectedCaseIds.length
  const selectedDatasetInfo =
    datasetIds.length === 1
      ? (catalog?.datasets.find((item) => item.id === datasetId)?.name ?? '等待目录加载')
      : (catalog?.datasets
          .filter((item) => datasetIds.includes(item.id))
          .map((item) => item.name)
          .join(' + ') ?? '等待目录加载')
  return (
    <>
      <div className="bench-page-heading">
        <div>
          <span className="bench-kicker">Evaluation workspace / 01</span>
          <h1>评测集</h1>
          <p>选择评测数据，配置 Agent 运行计划，并开始一次可追踪的实验。</p>
        </div>
      </div>
      <div className="bench-layout-grid">
        <section className="bench-panel">
          <div className="bench-toolbar">
            <div>
              <h2>平台评测目录</h2>
            </div>
            <span className="bench-badge">{catalog?.datasets.length ?? 0} 个数据集</span>
          </div>
          <div className="bench-dataset-list">
            {catalog?.datasets.map((item) => (
              <div className="bench-dataset-row" key={item.id}>
                <input
                  type="checkbox"
                  checked={datasetIds.includes(item.id)}
                  aria-label={`同时运行${item.name}`}
                  title="勾选后与其他评测集并行运行"
                  onChange={(event) =>
                    onDatasetIds(
                      event.target.checked
                        ? [...new Set([...datasetIds, item.id])]
                        : datasetIds.filter((id) => id !== item.id),
                    )
                  }
                />
                <button
                  className={`bench-dataset ${datasetIds.includes(item.id) ? 'selected' : ''}`}
                  onClick={() => onDataset(item.id)}
                >
                  <span>
                    <small className="bench-family">{item.family}</small>
                    <strong>{item.name}</strong>
                    <small>{item.description}</small>
                  </span>
                  <em>
                    {item.count} 道基础用例
                    {item.license ? ` · ${item.license}` : ''}
                  </em>
                </button>
              </div>
            )) ?? (
              <div className="bench-empty">
                {catalogFailed ? (
                  <>
                    <strong>无法读取评测目录</strong>
                    <span>{'平台接口暂不可用，请确认平台服务后重试。'}</span>
                    <button className="bench-secondary" onClick={onRetryCatalog}>
                      重试
                    </button>
                  </>
                ) : (
                  '正在读取 Catalog API…'
                )}
              </div>
            )}
          </div>
          {datasetIds.length > 1 && (
            <div className="bench-notice good">
              已选择 {datasetIds.length} 个评测集，将为每个评测集创建独立 BenchmarkRun
              并行执行；多选时使用各评测集的默认题目。
            </div>
          )}
          <div className="bench-case-heading">
            <h3>具体题目</h3>
            <span>
              {datasetIds.length > 1
                ? '多选时按默认题目'
                : `${selectedCaseIds.length} / ${selectedDataset?.cases.length ?? 0}`}
            </span>
          </div>
          {datasetIds.length === 1 && (
            <>
              <input
                className="bench-case-search"
                value={caseSearch}
                onChange={(event) => setCaseSearch(event.target.value)}
                placeholder="搜索题目或仓库"
              />
              <div className="bench-case-actions">
                <button
                  className="bench-case-action"
                  onClick={() =>
                    onCaseIds(
                      [
                        ...new Set([...selectedCaseIds, ...visibleCases.map((item) => item.id)]),
                      ].slice(0, 20),
                    )
                  }
                  disabled={
                    visibleCases.length === 0 ||
                    selectedCaseIds.length >= Math.min(20, visibleCases.length)
                  }
                >
                  全选本题库
                </button>
                <button
                  className="bench-case-action"
                  onClick={() => onCaseIds([])}
                  disabled={selectedCaseIds.length === 0}
                >
                  清空
                </button>
                <span className="bench-case-action-hint">单次实验最多 20 道题</span>
              </div>
              <div className="bench-case-list">
                {visibleCases.length === 0 ? (
                  <div className="bench-empty">暂无题目</div>
                ) : (
                  visibleCases.map((item) => (
                    <label className="bench-case" key={item.id}>
                      <input
                        type="checkbox"
                        checked={selectedCaseIds.includes(item.id)}
                        disabled={
                          !selectedCaseIds.includes(item.id) && selectedCaseIds.length >= 20
                        }
                        onChange={(event) =>
                          onCaseIds(
                            event.target.checked
                              ? [...new Set([...selectedCaseIds, item.id])]
                              : selectedCaseIds.filter((id) => id !== item.id),
                          )
                        }
                      />
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {item.id}
                          {item.repository ? ` · ${item.repository}` : ''}
                        </small>
                      </span>
                    </label>
                  ))
                )}
              </div>
            </>
          )}
        </section>
        <section className="bench-panel bench-plan-panel">
          <div className="bench-toolbar">
            <div>
              <h2>执行计划</h2>
            </div>
          </div>
          <label className="bench-field">
            执行模型
            <select
              value={modelId}
              onChange={(event) => onModel(event.target.value as Model['id'])}
            >
              {catalog?.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="bench-field">
            每题重复次数
            <select
              value={repetitions}
              onChange={(event) => onRepetitions(Number(event.target.value))}
            >
              {[1, 2, 3, 5, 10, 20].map((value) => (
                <option key={value} value={value}>
                  {value === 1 ? '1 次（冒烟）' : `${value} 次`}
                </option>
              ))}
            </select>
          </label>
          <div className="bench-plan">
            <strong>
              {planCaseCount} 道用例 × {repetitions} 次 = {planCaseCount * repetitions} 个 Trial
            </strong>
            <span>
              {repetitions === 1
                ? '单次为冒烟验证，结果不能判断稳定性。'
                : '每个 Trial 在独立环境中执行并单独判卷。'}
            </span>
          </div>
          <div className="bench-selection">
            <span>评测集</span>
            <strong>{selectedDatasetInfo}</strong>
          </div>
          <div className="bench-selection">
            <span>模型</span>
            <strong>{selectedModel?.name ?? '等待目录加载'}</strong>
          </div>
          {selectedModel && !selectedModel.synthetic && (
            <label className="bench-check">
              <input
                type="checkbox"
                checked={allowPaid}
                onChange={(event) => onAllowPaid(event.target.checked)}
              />{' '}
              我确认本次评测会消耗真实模型额度
            </label>
          )}
          <button
            className="bench-primary bench-wide"
            onClick={onCreate}
            disabled={
              !catalog ||
              creating ||
              (datasetIds.length === 1 && !selectedCaseIds.length) ||
              (!selectedModel?.synthetic && !allowPaid)
            }
          >
            {creating ? '创建中…' : '创建实验'}
          </button>
        </section>
      </div>
      <section className="bench-panel bench-dataset-chart" aria-label="数据集规模对比">
        <h3>数据集规模对比</h3>
        <p>已导入的评测集可直接创建实验；空心条为尚未导入数据的目录。</p>
        <DatasetSizeChart
          items={(catalog?.datasets ?? []).map((item) => ({
            name: item.name,
            count: item.count,
            imported: item.count > 0,
          }))}
        />
      </section>
    </>
  )
}

function JobsView({
  jobs,
  detail,
  selectedJobId,
  selectedTrial,
  selectedProgress,
  onSelect,
  onTrial,
  onCancel,
  selectedJobIds,
  onSelectedJobIds,
  onDeleteSelected,
  onCreate,
}: {
  jobs: Job[]
  detail: JobDetail | null
  selectedJobId: string | null
  selectedTrial: Trial | null
  selectedProgress: JobProgress | null
  onSelect: (id: string) => void
  onTrial: (key: string) => void
  onCancel: () => void
  selectedJobIds: string[]
  onSelectedJobIds: (ids: string[]) => void
  onDeleteSelected: (ids?: string[]) => void
  onCreate: () => void
}) {
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'failed' | 'completed'>(
    'all',
  )
  const [query, setQuery] = useState('')
  const [compareOpen, setCompareOpen] = useState(false)
  const activeJobStatuses: JobStatus[] = ['queued', 'running', 'cancelling']
  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return jobs.filter((job) => {
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'running'
            ? activeJobStatuses.includes(job.status)
            : statusFilter === 'failed'
              ? ['failed', 'cancelled', 'interrupted'].includes(job.status)
              : job.status === 'completed'
      const matchesQuery = normalizedQuery
        ? `${job.id} ${job.datasetName} ${job.datasetId} ${job.modelName}`
            .toLowerCase()
            .includes(normalizedQuery)
        : true
      return matchesStatus && matchesQuery
    })
  }, [activeJobStatuses, jobs, query, statusFilter])
  const comparableJobs = jobs.filter((job) => selectedJobIds.includes(job.id)).slice(0, 3)
  const finishedJobs = jobs.filter((job) => !activeJobStatuses.includes(job.status))
  const runningJobs = jobs.filter((job) => activeJobStatuses.includes(job.status))
  const failedJobs = jobs.filter((job) =>
    ['failed', 'cancelled', 'interrupted'].includes(job.status),
  )
  return (
    <>
      <div className="bench-page-heading">
        <div>
          <span className="bench-kicker">Evaluation workspace / 02</span>
          <h1>实验记录</h1>
          <p>查看每次 Evaluation Run 的实时进度、Trial 结果和失败证据。</p>
        </div>
        <div className="bench-page-actions">
          {selectedJobIds.length > 0 && (
            <button className="bench-danger-link" onClick={() => onDeleteSelected()}>
              删除选中（{selectedJobIds.length}）
            </button>
          )}
          <button className="bench-primary" onClick={onCreate}>
            创建实验
          </button>
        </div>
      </div>
      <section className="bench-panel bench-flush">
        <div className="bench-experiment-toolbar">
          <div className="bench-filter-tabs" role="tablist" aria-label="实验状态筛选">
            {[
              { id: 'all' as const, label: '全部', count: jobs.length },
              { id: 'running' as const, label: '运行中', count: runningJobs.length },
              { id: 'failed' as const, label: '需关注', count: failedJobs.length },
              {
                id: 'completed' as const,
                label: '已完成',
                count: finishedJobs.filter((job) => job.status === 'completed').length,
              },
            ].map((filter) => (
              <button
                className={statusFilter === filter.id ? 'active' : ''}
                key={filter.id}
                onClick={() => setStatusFilter(filter.id)}
                role="tab"
                aria-selected={statusFilter === filter.id}
              >
                {filter.label} <span>{filter.count}</span>
              </button>
            ))}
          </div>
          <div className="bench-experiment-toolbar-actions">
            <label className="bench-table-search">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 Job、评测集或模型"
                aria-label="搜索实验记录"
              />
            </label>
            {selectedJobIds.length >= 2 && (
              <button
                className="bench-secondary"
                onClick={() => setCompareOpen((current) => !current)}
              >
                {compareOpen ? '收起对比' : `并排对比 ${Math.min(selectedJobIds.length, 3)} 个`}
              </button>
            )}
          </div>
        </div>
        <div className="bench-table-scroll">
          <table className="bench-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="全选已结束记录"
                    checked={
                      filteredJobs.filter((job) => !activeJobStatuses.includes(job.status)).length >
                        0 &&
                      filteredJobs
                        .filter((job) => !activeJobStatuses.includes(job.status))
                        .every((job) => selectedJobIds.includes(job.id))
                    }
                    onChange={(event) =>
                      onSelectedJobIds(
                        event.target.checked
                          ? filteredJobs
                              .filter((job) => !activeJobStatuses.includes(job.status))
                              .map((job) => job.id)
                          : [],
                      )
                    }
                  />
                </th>
                <th>Job</th>
                <th>评测集</th>
                <th>Agent / 模型</th>
                <th>进度</th>
                <th>结果</th>
                <th>耗时</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredJobs.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <div className="bench-table-empty">
                      <strong>{jobs.length === 0 ? '还没有实验记录' : '没有匹配的实验'}</strong>
                      <span>
                        {jobs.length === 0
                          ? '创建一次实验后，这里会保留每个评测集的运行快照。'
                          : '试试清除搜索词，或切换其他状态。'}
                      </span>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredJobs.map((job) => (
                  <tr
                    key={job.id}
                    className={selectedJobId === job.id ? 'selected-row' : ''}
                    onClick={() => onSelect(job.id)}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${job.id}`}
                        checked={selectedJobIds.includes(job.id)}
                        disabled={['queued', 'running', 'cancelling'].includes(job.status)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          onSelectedJobIds(
                            event.target.checked
                              ? [...selectedJobIds, job.id]
                              : selectedJobIds.filter((id) => id !== job.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <strong className="bench-job-id" title={job.id}>
                        {job.id.slice(0, 8)}
                      </strong>
                    </td>
                    <td>
                      {job.datasetName}
                      <small>{job.datasetId}</small>
                    </td>
                    <td>
                      {job.modelName}
                      <small>{job.synthetic ? '流程验证模型' : '真实模型'}</small>
                    </td>
                    <td>
                      <div className="bench-progress">
                        <span
                          style={{
                            width: `${job.total ? Math.min(100, (job.completed / job.total) * 100) : 0}%`,
                          }}
                        />
                      </div>
                      <small>
                        {job.completed} / {job.total} Trial
                      </small>
                    </td>
                    <td>
                      <MiniStack counts={jobStackCounts(job)} />
                      {job.summary ? (
                        <span className="bench-result-counts">
                          <span className="pass">✓ {job.summary.passedCases ?? 0}</span>
                          <span className="fail">✗ {job.summary.failedCases ?? 0}</span>
                          {Math.max(
                            0,
                            (job.summary.totalCases ?? 0) -
                              (job.summary.passedCases ?? 0) -
                              (job.summary.failedCases ?? 0),
                          ) > 0 && (
                            <span className="unknown">
                              ?{' '}
                              {Math.max(
                                0,
                                (job.summary.totalCases ?? 0) -
                                  (job.summary.passedCases ?? 0) -
                                  (job.summary.failedCases ?? 0),
                              )}
                            </span>
                          )}
                        </span>
                      ) : (
                        <small>—</small>
                      )}
                    </td>
                    <td>
                      <small>
                        {job.summary
                          ? formatDuration(job.summary.durationMs)
                          : ['queued', 'running', 'cancelling'].includes(job.status)
                            ? '执行中'
                            : '—'}
                      </small>
                    </td>
                    <td>
                      <span className={`bench-status ${statusClasses[job.status]}`}>
                        {statusLabels[job.status]}
                      </span>
                    </td>
                    <td>{formatDate(job.createdAt)}</td>
                    <td>
                      {!['queued', 'running', 'cancelling'].includes(job.status) && (
                        <button
                          className="bench-danger-link"
                          onClick={(event) => {
                            event.stopPropagation()
                            void onDeleteSelected([job.id])
                          }}
                        >
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      {compareOpen && comparableJobs.length >= 2 && (
        <section className="bench-compare-panel" aria-label="实验对比">
          <div className="bench-compare-heading">
            <div>
              <span className="bench-kicker">EXPERIMENT COMPARISON</span>
              <h2>并排查看实验快照</h2>
              <p>先比较质量、耗时和覆盖量，再选择某个实验下钻到 Trial 与完整事件。</p>
            </div>
            <span className="bench-badge">{comparableJobs.length} 个实验</span>
          </div>
          <div className="bench-compare-grid">
            {comparableJobs.map((job) => (
              <article className="bench-compare-card" key={job.id}>
                <div className="bench-compare-card-topline">
                  <span>{job.datasetName}</span>
                  <span className={`bench-status ${statusClasses[job.status]}`}>
                    {statusLabels[job.status]}
                  </span>
                </div>
                <strong>{job.id.slice(0, 8)}</strong>
                <small>
                  {job.modelName} · {formatDate(job.createdAt)}
                </small>
                <div className="bench-compare-metrics">
                  <div>
                    <span>通过率</span>
                    <strong>
                      {job.summary ? `${Math.round(job.summary.passRate * 100)}%` : '—'}
                    </strong>
                  </div>
                  <div>
                    <span>耗时</span>
                    <strong>
                      {job.summary ? formatDuration(job.summary.durationMs) : '执行中'}
                    </strong>
                  </div>
                  <div>
                    <span>Trial</span>
                    <strong>
                      {job.completed} / {job.total}
                    </strong>
                  </div>
                </div>
                <div style={{ margin: '8px 0 2px' }}>
                  <ResultStackBar counts={jobStackCounts(job)} />
                </div>
                <button
                  className="bench-secondary bench-compare-open"
                  onClick={() => onSelect(job.id)}
                >
                  查看实验详情
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      {detail && (
        <JobDetailView
          detail={detail}
          selectedTrial={selectedTrial}
          selectedProgress={selectedProgress}
          onTrial={onTrial}
          onCancel={onCancel}
        />
      )}
    </>
  )
}

function JobDetailView({
  detail,
  selectedTrial,
  selectedProgress,
  onTrial,
  onCancel,
}: {
  detail: JobDetail
  selectedTrial: Trial | null
  selectedProgress: JobProgress | null
  onTrial: (key: string) => void
  onCancel: () => void
}) {
  const active = ['queued', 'running', 'cancelling'].includes(detail.status)
  const trialProgresses = detail.trialProgresses
  const detailStack = useMemo(() => {
    const pass = detail.trials.filter((trial) => overviewTrialBucket(trial) === 'pass').length
    const fail = detail.trials.filter((trial) => overviewTrialBucket(trial) === 'fail').length
    const unknown = detail.trials.filter((trial) => overviewTrialBucket(trial) === 'unknown').length
    return {
      pass,
      fail,
      unknown,
      pending: Math.max(0, detail.total - detail.trials.length),
    }
  }, [detail.total, detail.trials])
  const resultByKey = useMemo(
    () => new Map(detail.trials.map((trial) => [trialKey(trial), trial])),
    [detail.trials],
  )
  const liveProgresses = useMemo(
    () => trialProgresses.filter((progress) => !progressCompleted(progress)),
    [trialProgresses],
  )
  const liveProgressKeys = liveProgresses.map(progressKey).join('|')
  const progressGroups = useMemo<ProgressGroup[]>(() => {
    const assigned = new Set<string>()
    const groups: ProgressGroup[] = detail.benchmarkRuns.map((run) => {
      const progresses = trialProgresses.filter((progress) => {
        const matches = progress.benchmarkRunId === run.benchmarkRunId
        if (matches) {
          assigned.add(progressKey(progress))
        }
        return matches
      })
      return { id: run.benchmarkRunId, run, progresses }
    })
    const ungrouped = trialProgresses.filter((progress) => !assigned.has(progressKey(progress)))
    if (ungrouped.length > 0) {
      groups.push({ id: 'ungrouped', run: null, progresses: ungrouped })
    }
    return groups
  }, [detail.benchmarkRuns, trialProgresses])
  const selectedProgressKey = selectedProgress ? progressKey(selectedProgress) : null
  const [eventState, setEventState] = useState<{
    jobId: string
    byTrial: Record<string, RunEvent[]>
  }>({ jobId: detail.id, byTrial: {} })

  useEffect(() => {
    setEventState((current) => {
      const byTrial = current.jobId === detail.id ? { ...current.byTrial } : {}
      for (const progress of trialProgresses) {
        const key = progressKey(progress)
        byTrial[key] = mergeRunEvents(byTrial[key] ?? [], progress.events)
      }
      return { jobId: detail.id, byTrial }
    })
  }, [detail.id, trialProgresses])

  const eventsForProgress = useCallback(
    (progress: JobProgress) =>
      eventState.jobId === detail.id
        ? (eventState.byTrial[progressKey(progress)] ?? progress.events)
        : progress.events,
    [detail.id, eventState],
  )

  useEffect(() => {
    if (!selectedProgress || !selectedProgressKey) {
      return
    }
    let mounted = true
    const query = new URLSearchParams({ offset: '0', limit: '200' })
    if (selectedProgress.benchmarkRunId) {
      query.set('benchmarkRunId', selectedProgress.benchmarkRunId)
    }
    void api<{ items: RunEvent[] }>(
      `/api/jobs/${detail.id}/trials/${selectedProgress.trialId}/events?${query.toString()}`,
    )
      .then((value) => {
        if (mounted) {
          setEventState((current) => ({
            ...current,
            byTrial: {
              ...current.byTrial,
              [selectedProgressKey]: mergeRunEvents(
                current.byTrial[selectedProgressKey] ?? [],
                value.items,
              ),
            },
          }))
        }
      })
      .catch(() => {
        // The detail response still contains the bounded event snapshot.
      })
    return () => {
      mounted = false
    }
  }, [detail.id, selectedProgress, selectedProgressKey])

  useEffect(() => {
    if (!active || liveProgresses.length === 0) {
      return
    }
    const streams = liveProgresses.map((progress) => {
      const query = new URLSearchParams()
      if (progress.benchmarkRunId) {
        query.set('benchmarkRunId', progress.benchmarkRunId)
      }
      const key = progressKey(progress)
      const stream = new EventSource(
        `/api/jobs/${detail.id}/trials/${encodeURIComponent(progress.trialId)}/events/stream?${query.toString()}`,
      )
      const onEvent = (message: Event) => {
        try {
          const event = JSON.parse((message as MessageEvent<string>).data) as RunEvent
          setEventState((current) => ({
            ...current,
            byTrial: {
              ...current.byTrial,
              [key]: mergeRunEvents(current.byTrial[key] ?? [], [event]),
            },
          }))
        } catch {
          // Ignore malformed live frames; the next polling refresh can recover the state.
        }
      }
      stream.addEventListener('run-event', onEvent)
      return { stream, onEvent }
    })
    return () => {
      for (const { stream, onEvent } of streams) {
        stream.removeEventListener('run-event', onEvent)
        stream.close()
      }
    }
  }, [active, detail.id, liveProgressKeys])

  const selectedEvents = selectedProgress ? eventsForProgress(selectedProgress) : []
  const selectedLatestEvent = selectedEvents.at(-1)
  const visibleSelectedEvents = visibleTimelineEvents(
    selectedEvents.filter((event) => event.type !== 'model.text_delta'),
  )

  return (
    <section className="bench-panel bench-detail">
      <div className="bench-detail-head">
        <div>
          <span className="bench-kicker">JOB DETAIL</span>
          <h2>
            {detail.datasetName} · {detail.id.slice(0, 8)}
          </h2>
          <p>
            {detail.modelName} · 创建于 {formatDate(detail.createdAt)}
          </p>
        </div>
        <div className="bench-detail-actions">
          <span className={`bench-status ${statusClasses[detail.status]}`}>
            {statusLabels[detail.status]}
          </span>
          {active && (
            <button className="bench-danger" onClick={onCancel}>
              取消 Job
            </button>
          )}
        </div>
      </div>
      <div className="bench-stats">
        <div>
          <strong>
            {detail.completed} / {detail.total}
          </strong>
          <span>已完成 Trial</span>
        </div>
        <div>
          <strong>{detail.summary ? `${Math.round(detail.summary.passRate * 100)}%` : '—'}</strong>
          <span>通过率</span>
        </div>
        <div>
          <strong>
            {detail.summary ? (
              <>
                <span className="bench-stat-pass">✓ {detail.summary.passedCases ?? 0}</span>{' '}
                <span className="bench-stat-fail">✗ {detail.summary.failedCases ?? 0}</span>
                {Math.max(
                  0,
                  (detail.summary.totalCases ?? 0) -
                    (detail.summary.passedCases ?? 0) -
                    (detail.summary.failedCases ?? 0),
                ) > 0 && (
                  <span className="bench-stat-unknown">
                    {' '}
                    ?{' '}
                    {Math.max(
                      0,
                      (detail.summary.totalCases ?? 0) -
                        (detail.summary.passedCases ?? 0) -
                        (detail.summary.failedCases ?? 0),
                    )}
                  </span>
                )}
              </>
            ) : (
              '—'
            )}
          </strong>
          <span>通过 / 不通过 / 未判定</span>
        </div>
        <div>
          <strong>{detail.summary ? formatDuration(detail.summary.durationMs) : '执行中'}</strong>
          <span>总耗时</span>
        </div>
        <div>
          <strong>{detail.trials.reduce((sum, item) => sum + item.metrics.toolCalls, 0)}</strong>
          <span>工具调用</span>
        </div>
      </div>
      {detail.message && <div className="bench-notice error">{detail.message}</div>}
      <div style={{ margin: '18px 0 4px' }}>
        <ResultStackBar counts={detailStack} />
        <div className="bench-muted" style={{ marginTop: 8, fontSize: 12 }}>
          通过 {detailStack.pass} · 不通过 {detailStack.fail} · 未判定 {detailStack.unknown} ·
          未完成 {detailStack.pending}（未判定与未完成不等同于不通过）
        </div>
      </div>
      <section className="bench-runs-overview" aria-labelledby="bench-runs-overview-title">
        <div className="bench-section-heading">
          <div>
            <h3 id="bench-runs-overview-title">评测集执行</h3>
            <p>
              {detail.benchmarkRuns.length > 1
                ? `${detail.benchmarkRuns.length} 个评测集独立执行，结果与事件按评测集分组。`
                : '当前评测集的执行状态与完成情况。'}
            </p>
          </div>
          <span className="bench-section-count">{detail.benchmarkRuns.length} 个评测集</span>
        </div>
        <div className="bench-run-grid">
          {detail.benchmarkRuns.map((run, index) => {
            const group = progressGroups.find((item) => item.id === run.benchmarkRunId)
            const current = group?.progresses.find((item) => !progressCompleted(item))
            const passRate = run.summary ? Math.round(run.summary.passRate * 100) : null
            return (
              <button
                className={`bench-run-summary ${current ? 'is-live' : ''}`}
                key={run.benchmarkRunId}
                onClick={() => {
                  const first = group?.progresses[0]
                  if (first) {
                    onTrial(progressKey(first))
                  }
                }}
                disabled={!group?.progresses.length}
              >
                <span className="bench-run-summary-topline">
                  <span className="bench-run-number">RUN {String(index + 1).padStart(2, '0')}</span>
                  <span className={`bench-status ${statusClasses[run.status]}`}>
                    {statusLabels[run.status]}
                  </span>
                </span>
                <strong>{run.datasetName}</strong>
                <span className="bench-run-summary-meta">
                  {run.completed} / {run.total} Trial
                  {passRate === null ? ' · 计算中' : ` · 通过率 ${passRate}%`}
                </span>
                <MiniStack counts={jobStackCounts(run)} />
                <span className="bench-run-progress" aria-hidden="true">
                  <span
                    style={{
                      width: `${run.total ? Math.min(100, (run.completed / run.total) * 100) : 0}%`,
                    }}
                  />
                </span>
                <span className="bench-run-summary-current">
                  {current
                    ? `当前：${current.caseId}`
                    : group?.progresses.length
                      ? '执行已完成'
                      : '等待开始'}
                </span>
              </button>
            )
          })}
        </div>
      </section>
      {active ? (
        <div className="bench-live-progress is-live">
          <div className="bench-live-progress-head">
            <div>
              <h3>并发执行过程</h3>
              <p>
                {trialProgresses.length
                  ? `${trialProgresses.length} 个 Trial 各自保留完整事件时间线，实时执行不会互相覆盖。`
                  : active
                    ? 'Worker 已启动，等待第一条执行事件…'
                    : '没有可展示的执行事件'}
              </p>
            </div>
            <span className={`bench-status ${active ? 'status-running' : 'status-muted'}`}>
              {active ? `${liveProgresses.length} 个实时 Trial` : statusLabels[detail.status]}
            </span>
          </div>
          {progressGroups.length ? (
            <div className="bench-progress-groups">
              {progressGroups.map((group, groupIndex) => (
                <section className="bench-progress-group" key={group.id}>
                  <div className="bench-progress-group-heading">
                    <div>
                      <span className="bench-run-number">
                        RUN {String(groupIndex + 1).padStart(2, '0')}
                      </span>
                      <strong>{group.run?.datasetName ?? '未分组 Trial'}</strong>
                    </div>
                    <span>
                      {group.progresses.length
                        ? `${group.progresses.length} 个 Trial`
                        : '等待第一个 Trial'}
                    </span>
                  </div>
                  {group.progresses.length ? (
                    <div className="bench-progress-grid">
                      {group.progresses.map((progress) => {
                        const key = progressKey(progress)
                        const events = eventsForProgress(progress)
                        const timeline = visibleTimelineEvents(
                          events.filter((event) => event.type !== 'model.text_delta'),
                        )
                        const result = resultByKey.get(key)
                        const latest = progressLatestEvent(progress, events)
                        const completed = progressCompleted(progress, events)
                        const isSelected = selectedProgressKey === key
                        return (
                          <div
                            className={`bench-progress-card ${isSelected ? 'selected' : ''}`}
                            key={key}
                          >
                            <button
                              className="bench-progress-card-button"
                              onClick={() => onTrial(key)}
                            >
                              <span>
                                <strong>{shortId(progress.caseId, 20)}</strong>
                                <small>{shortId(progress.trialId)}</small>
                              </span>
                              <span
                                className={`bench-status ${result ? (result.resolved ? 'status-ready' : 'status-error') : completed ? 'status-muted' : 'status-running'}`}
                              >
                                {result
                                  ? result.resolved
                                    ? '通过'
                                    : '未通过'
                                  : completed
                                    ? '已完成'
                                    : '执行中'}
                              </span>
                            </button>
                            <div className="bench-progress-card-meta">
                              <span>{events.length} 个事件</span>
                              <span>{latest ? eventLabel(latest) : '等待事件'}</span>
                            </div>
                            {timeline.length ? (
                              <ol className="bench-progress-card-timeline">
                                {timeline.slice(-4).map((event, index, visible) => (
                                  <li
                                    className={index === visible.length - 1 ? 'current' : ''}
                                    key={eventKey(event)}
                                  >
                                    <span className="bench-event-dot" />
                                    <span>{eventLabel(event)}</span>
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <div className="bench-progress-card-empty">等待第一条事件…</div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="bench-progress-group-empty">
                      该评测集已入队，等待 Trial 开始。
                    </div>
                  )}
                </section>
              ))}
            </div>
          ) : (
            <div className="bench-empty">正在等待 Worker 事件…</div>
          )}
        </div>
      ) : (
        <section className="bench-complete-summary" aria-label="执行审计摘要">
          <div>
            <span className="bench-kicker">RUN AUDIT</span>
            <strong>执行审计已完成</strong>
            <p>{trialProgresses.length} 个 Trial 已归档，选择下方 Trial 查看诊断、事件与 Diff。</p>
          </div>
          <span className="bench-status status-muted">按需下钻</span>
        </section>
      )}
      <div className="bench-trial-layout">
        <div>
          <h3>Trial 结果</h3>
          <div className="bench-trials">
            {trialProgresses.length === 0 && detail.trials.length === 0 ? (
              <div className="bench-empty">执行中…</div>
            ) : progressGroups.length ? (
              <div className="bench-trial-result-groups">
                {progressGroups.map((group, groupIndex) => (
                  <section className="bench-trial-result-group" key={group.id}>
                    <div className="bench-trial-group-heading">
                      <strong>{group.run?.datasetName ?? `评测集 ${groupIndex + 1}`}</strong>
                      <span>{group.progresses.length} 个 Trial</span>
                    </div>
                    {group.progresses.length ? (
                      group.progresses.map((progress) => {
                        const key = progressKey(progress)
                        const trial = resultByKey.get(key)
                        const status = trial
                          ? trial.resolved
                            ? '通过'
                            : trial.verification.status === 'error'
                              ? '判卷错误'
                              : '未通过'
                          : progressCompleted(progress)
                            ? '已完成，等待结果'
                            : '执行中'
                        return (
                          <button
                            key={key}
                            className={`bench-trial ${trial ? (trial.resolved ? 'pass' : 'fail') : 'running'} ${selectedProgressKey === key ? 'selected' : ''}`}
                            onClick={() => onTrial(key)}
                          >
                            <strong>{shortId(progress.caseId, 20)}</strong>
                            <span>{status}</span>
                          </button>
                        )
                      })
                    ) : (
                      <div className="bench-trial-group-empty">等待 Trial 开始…</div>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              detail.trials.map((trial) => (
                <button
                  key={trialKey(trial)}
                  className={`bench-trial ${trial.resolved ? 'pass' : 'fail'} ${selectedTrial && trialKey(selectedTrial) === trialKey(trial) ? 'selected' : ''}`}
                  onClick={() => onTrial(trialKey(trial))}
                >
                  <strong>{trial.caseId}</strong>
                  <span>
                    {trial.resolved
                      ? '通过'
                      : trial.verification.status === 'error'
                        ? '判卷错误'
                        : '未通过'}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
        <div>
          {selectedTrial ? (
            <>
              <div className="bench-trial-heading">
                <div>
                  <h3>{selectedTrial.caseId}</h3>
                  <span className="bench-muted bench-small">
                    {shortId(selectedTrial.trialId)} ·{' '}
                    {formatDuration(selectedTrial.metrics.durationMs)} ·{' '}
                    {selectedTrial.metrics.toolCalls} 次工具调用
                  </span>
                </div>
                <span
                  className={`bench-status ${selectedTrial.resolved ? 'status-ready' : 'status-error'}`}
                >
                  {selectedTrial.resolved ? '验证通过' : '验证未通过'}
                </span>
              </div>
              <TrialOutcome trial={selectedTrial} events={selectedEvents} />
              <FileDiffList diffs={selectedTrial.diffs} />
            </>
          ) : selectedProgress ? (
            <LiveTrialDetail
              progress={selectedProgress}
              events={selectedEvents}
              latestEvent={selectedLatestEvent}
              visibleEvents={visibleSelectedEvents}
            />
          ) : (
            <div className="bench-empty">选择一个 Trial 查看结果和 Diff。</div>
          )}
        </div>
      </div>
    </section>
  )
}

function LiveTrialDetail({
  progress,
  events,
  latestEvent,
  visibleEvents,
}: {
  progress: JobProgress
  events: RunEvent[]
  latestEvent: RunEvent | undefined
  visibleEvents: RunEvent[]
}) {
  return (
    <div className="bench-live-trial">
      <div className="bench-trial-heading">
        <div>
          <h3>{progress.caseId}</h3>
          <span className="bench-muted bench-small">
            {shortId(progress.trialId)} · {events.length} 个事件
          </span>
        </div>
        <span className="bench-status status-running">执行中</span>
      </div>
      <div className="bench-live-trial-current">
        <span className="bench-event-dot" />
        <div>
          <strong>{latestEvent ? eventLabel(latestEvent) : '等待事件'}</strong>
          {latestEvent && <time>{formatDate(latestEvent.timestamp)}</time>}
        </div>
      </div>
      {visibleEvents.length ? (
        <ol className="bench-event-list">
          {visibleEvents.map((event, index, timeline) => (
            <li className={index === timeline.length - 1 ? 'current' : ''} key={eventKey(event)}>
              <span className="bench-event-dot" />
              <div>
                <strong>{eventLabel(event)}</strong>
                <time>{formatDate(event.timestamp)}</time>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="bench-empty">正在等待 Worker 事件…</div>
      )}
    </div>
  )
}

function TrialOutcome({ trial, events }: { trial: Trial; events: RunEvent[] }) {
  const answer = agentAnswer(events)
  const verificationEvent = latestEvent(events, 'verification.completed')
  const verificationData = verificationEvent ? eventData(verificationEvent) : {}
  const verificationMessage =
    typeof verificationData.message === 'string' ? verificationData.message : undefined
  const verifierOutput = verificationOutput(events)
  const isEmptySubmission =
    trial.submission.status === 'empty' || trial.submission.status === 'missing'
  const diagnosedLayer = trial.failure?.diagnosis?.layer
  const failureTitle = isEmptySubmission
    ? '没有生成可验证的代码修改'
    : diagnosedLayer
      ? `评测失败 · ${failureLayerLabels[diagnosedLayer] ?? diagnosedLayer}`
      : trial.failure?.category
  const failureMessage = isEmptySubmission
    ? 'Agent 结束了执行，但工作区没有产生非空 Git diff，判卷器没有可验证的修改内容。'
    : verificationMessage || trial.failure?.message
  const failureEvents = diagnosticEvents(events)
  const toolCallCount = events.filter((event) => event.type === 'tool.started').length
  return (
    <div className="bench-outcome">
      <div className="bench-outcome-grid">
        <div>
          <span>执行</span>
          <strong>{outcomeStatus(trial.execution.status)}</strong>
        </div>
        <div>
          <span>提交</span>
          <strong>{outcomeStatus(trial.submission.status)}</strong>
        </div>
        <div>
          <span>验证</span>
          <strong>{outcomeStatus(trial.verification.status)}</strong>
        </div>
        <div>
          <span>工作区</span>
          <strong>{outcomeStatus(trial.infrastructure.status)}</strong>
        </div>
      </div>
      {failureMessage && (
        <div className="bench-outcome-error">
          <div className="bench-outcome-error-title">
            <span className="bench-outcome-error-icon" aria-hidden="true">
              !
            </span>
            <strong>{failureTitle}</strong>
          </div>
          <p>{failureMessage}</p>
          <div className="bench-failure-summary">
            <div>
              <span>主要失败层级</span>
              <strong>{failureLayer(trial)}</strong>
            </div>
            <div>
              <span>失败阶段</span>
              <strong>
                {trial.failure?.diagnosis?.stage
                  ? (failureStageLabels[trial.failure.diagnosis.stage] ??
                    trial.failure.diagnosis.stage)
                  : trial.verification.status === 'error'
                    ? '验证器'
                    : outcomeStatus(trial.execution.status)}
              </strong>
            </div>
            <div>
              <span>Agent 状态</span>
              <strong>{outcomeStatus(trial.execution.status)}</strong>
            </div>
            <div>
              <span>代码提交</span>
              <strong>
                {trial.diffs?.length
                  ? `已生成补丁，${trial.diffs.length} 个文件`
                  : outcomeStatus(trial.submission.status)}
              </strong>
            </div>
            <div>
              <span>工作区状态</span>
              <strong>{outcomeStatus(trial.infrastructure.status)}</strong>
            </div>
          </div>
          {trial.failure?.diagnosis && (
            <div className="bench-outcome-next">
              <strong>
                定位结论 ·{' '}
                {failureLayerLabels[trial.failure.diagnosis.layer] ?? trial.failure.diagnosis.layer}
              </strong>
              <span>{trial.failure.diagnosis.rootCause}</span>
              <span>建议：{trial.failure.diagnosis.suggestion}</span>
            </div>
          )}
          <div className="bench-diagnosis-facts">
            <span>
              <b>工具调用</b>
              {toolCallCount > 0 ? `${toolCallCount} 次` : '0 次'}
            </span>
            <span>
              <b>文件变化</b>
              {trial.diffs && trial.diffs.length > 0 ? `${trial.diffs.length} 个文件` : '未检测到'}
            </span>
            <span>
              <b>失败阶段</b>
              {isEmptySubmission ? '提交' : outcomeStatus(trial.verification.status)}
            </span>
          </div>
          {isEmptySubmission && (
            <div className="bench-outcome-next">
              <strong>建议检查</strong>
              <span>
                Agent 是否实际编辑了文件、是否在正确的 worktree 中操作，以及结束前是否生成了 patch。
              </span>
            </div>
          )}
          {failureEvents.length > 0 && (
            <div className="bench-diagnostic-events">
              <strong>关键失败事件</strong>
              {failureEvents.slice(0, 4).map((event) => {
                const data = eventData(event)
                const toolName = typeof data.toolName === 'string' ? data.toolName : '验证器'
                const stage = typeof data.name === 'string' ? data.name : undefined
                const message =
                  typeof data.message === 'string'
                    ? data.message
                    : typeof data.error === 'string'
                      ? data.error
                      : event.type === 'verification.stage' && typeof data.status === 'string'
                        ? data.status === 'completed'
                          ? '已完成'
                          : data.status === 'started'
                            ? '已开始'
                            : '阶段失败'
                        : '未提供详细错误信息'
                return (
                  <div
                    className="bench-diagnostic-event"
                    key={`${event.trialId}-${event.sequence}`}
                  >
                    <span>#{event.sequence}</span>
                    <b>
                      {event.type === 'tool.failed'
                        ? `工具失败 · ${toolName}`
                        : event.type === 'verification.stage'
                          ? `验证阶段 · ${stage ? (verificationStageLabels[stage] ?? stage) : '未知'}`
                          : '验证失败'}
                    </b>
                    <em>{message}</em>
                  </div>
                )
              })}
              {failureEvents.length > 4 && (
                <span className="bench-diagnostic-more">
                  还有 {failureEvents.length - 4} 条事件，查看下方原始输出
                </span>
              )}
            </div>
          )}
          {verifierOutput.length > 0 && (
            <details className="bench-external-output">
              <summary>第三方验证器原始输出（{verifierOutput.length} 条）</summary>
              <pre>{verifierOutput.join('\n\n')}</pre>
            </details>
          )}
          {trial.failure?.evidence && trial.failure.evidence.length > 0 && (
            <details className="bench-raw-diagnostic">
              <summary>诊断摘要（{trial.failure.evidence.length} 条）</summary>
              <div className="bench-evidence-list">
                {trial.failure.evidence.map((evidence, index) => (
                  <div className="bench-evidence-item" key={`${index}-${evidence.slice(0, 20)}`}>
                    <span>{index + 1}</span>
                    <strong>{evidenceTitle(evidence)}</strong>
                    <p>{evidence}</p>
                  </div>
                ))}
              </div>
              <details className="bench-raw-log">
                <summary>查看原始日志</summary>
                <small>{trial.failure.evidence.join('\n')}</small>
              </details>
            </details>
          )}
        </div>
      )}
      {verificationMessage && <p className="bench-outcome-message">{verificationMessage}</p>}
      <div className="bench-answer">
        <h4>Agent 答案</h4>
        {answer ? (
          <div className="bench-answer-markdown">{renderAgentMarkdown(answer)}</div>
        ) : (
          <p>
            {isEmptySubmission
              ? 'Agent 没有提交代码修改，因此没有可展示的答案或 Diff。'
              : '没有可展示的文本答案；文件型题目的答案请查看下方 Diff。'}
          </p>
        )}
      </div>
    </div>
  )
}
