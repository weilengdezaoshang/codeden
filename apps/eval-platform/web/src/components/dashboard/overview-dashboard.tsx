'use client'

import type { ReactNode } from 'react'
import { CaseDotMatrix, type CaseDotRow } from '../charts/case-dot-matrix'
import { ResultStackBar } from '../charts/result-stack-bar'
import { TrendSparkline } from '../charts/trend-sparkline'
import { MiniStack, type MiniStackCounts } from './mini-stack'
import { Badge } from '../ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { cn } from '../../lib/utils'

export type DashboardMatrixRow = CaseDotRow & {
  submissionType: 'files' | 'text'
  answer: string | null
}

export interface DashboardRunItem {
  id: string
  datasetName: string
  caption: string
  status: 'running' | 'queued' | 'completed' | 'failed' | 'stopped'
  metric: string
  stack: MiniStackCounts
  selected: boolean
}

const STATUS_DOT: Record<DashboardRunItem['status'], string> = {
  running: 'bg-[#e2a400]',
  queued: 'bg-[#e2a400]',
  completed: 'bg-pass',
  failed: 'bg-fail',
  stopped: 'bg-unknown',
}

export interface OverviewDashboardProps {
  datasetName: string
  chips: { label: string; mono?: boolean }[]
  statusLabel: string
  statusTone: 'ok' | 'vol' | 'warn' | 'inc'
  metaLine: ReactNode
  counts: {
    pass: number
    fail: number
    unknown: number
    pending: number
    completed: number
    planned: number
  }
  passRate: number | null
  validRate: number | null
  coverage: number | null
  rows: DashboardMatrixRow[]
  loading?: boolean
  resources: { label: string; value: string }[]
  trend: { caption: string; values: number[]; note: string } | null
  runs: DashboardRunItem[]
  context: { label: string; value: string }[]
  activeBanner?: { count: number; onClick: () => void }
  onCreate: () => void
  onOpenDetails: () => void
  onSelectJob: (id: string) => void
  expandedCaseId: string | null
  onToggleCase: (caseId: string) => void
  renderRowDetail: (row: DashboardMatrixRow) => ReactNode
}

function caseTag(row: DashboardMatrixRow): { label: string; tone: 'ok' | 'vol' | 'inc' } {
  const planned = row.pass + row.fail + row.unknown + row.pending
  if (row.pending === planned && planned > 0) {
    return { label: '排队中', tone: 'inc' }
  }
  if (row.unknown > 0 || row.pending > 0) {
    return { label: `不完整 ${row.pass}/${planned}`, tone: 'inc' }
  }
  if (row.pass === planned) {
    return { label: '全通过', tone: 'ok' }
  }
  if (row.fail === planned) {
    return { label: `全不通过 0/${planned}`, tone: 'vol' }
  }
  return { label: `波动 ${row.pass}/${planned}`, tone: 'vol' }
}

/** 总览主视图：左列 = 结果堆叠条 + 每题点阵；右栏 = 趋势、最近运行与运行上下文。 */
export function OverviewDashboard({
  datasetName,
  chips,
  statusLabel,
  statusTone,
  metaLine,
  counts,
  passRate,
  validRate,
  coverage,
  rows,
  loading = false,
  resources,
  trend,
  runs,
  context,
  activeBanner,
  onCreate,
  onOpenDetails,
  onSelectJob,
  expandedCaseId,
  onToggleCase,
  renderRowDetail,
}: OverviewDashboardProps) {
  const incomplete = counts.unknown > 0 || counts.pending > 0
  const expandedRow = rows.find((row) => row.caseId === expandedCaseId) ?? null

  return (
    <div className="flex flex-col gap-5">
      {activeBanner && activeBanner.count > 0 && (
        <button
          type="button"
          onClick={activeBanner.onClick}
          className="flex items-center gap-2 self-start rounded-full border border-[#f0dfb2] bg-[#fff8e6] px-4 py-1.5 text-[13px] transition-colors hover:bg-[#fff2cc]"
        >
          <span className="h-2 w-2 rounded-full bg-[#e2a400]" aria-hidden />
          正在执行 {activeBanner.count} 场评测，点击查看进度
        </button>
      )}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[19px] font-bold">{datasetName}</h1>
              {chips.map((chip) => (
                <Badge
                  key={chip.label}
                  tone="neutral"
                  className={cn(chip.mono && 'font-mono text-[11px]')}
                >
                  {chip.label}
                </Badge>
              ))}
              <Badge tone={statusTone}>{statusLabel}</Badge>
              <button
                type="button"
                onClick={onOpenDetails}
                className="ml-auto rounded-lg border border-railline px-3 py-1 text-[12.5px] text-inkmuted transition-colors hover:bg-railbg"
              >
                完整详情
              </button>
              <button
                type="button"
                onClick={onCreate}
                className="rounded-lg bg-[#2563eb] px-3 py-1 text-[12.5px] font-medium text-white transition-colors hover:bg-[#1d4fd7]"
              >
                新建评测
              </button>
            </div>
            <div className="mt-2.5 text-[12.5px] text-inkmuted">{metaLine}</div>

            <div className="mt-4">
              <ResultStackBar counts={counts} />
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
              <LegendItem color="bg-pass" label="通过" value={counts.pass} />
              <LegendItem color="bg-fail" label="不通过" value={counts.fail} />
              <LegendItem color="bg-unknown" label="未判定" value={counts.unknown} />
              <LegendItem color="bg-pending" label="未完成" value={counts.pending} />
              <span className="text-inkmuted">
                已处理 <b className="font-semibold tabular-nums text-ink">{counts.completed}</b>/
                {counts.planned}
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-4 text-xs text-inkmuted">
              <span>
                计划通过占比{' '}
                <b className="font-semibold tabular-nums text-ink">{percent(passRate)}</b>
              </span>
              <span>
                有效判定成功率{' '}
                <b className="font-semibold tabular-nums text-ink">{percent(validRate)}</b>
              </span>
              <span>
                覆盖率 <b className="font-semibold tabular-nums text-ink">{percent(coverage)}</b>
              </span>
              {incomplete && (
                <span className="font-medium text-[#b07800]">⚠ 结果不完整，不用于版本结论</span>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>每题成绩</CardTitle>
              <CardDescription>
                ● 通过 · ● 不通过 · ○ 未判定 · ◌ 未执行 · 点击行查看试次与证据
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="py-10 text-center text-[13px] text-inkmuted">
                  正在读取当前运行结果…
                </div>
              ) : rows.length === 0 ? (
                <div className="py-10 text-center text-[13px] text-inkmuted">
                  当前运行还没有可展示的结果。
                </div>
              ) : (
                <CaseDotMatrix rows={rows} onSelectCase={onToggleCase} />
              )}
              {expandedRow && (
                <div className="overview-inline-detail mt-4 rounded-xl border border-railline bg-railbg p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <code className="text-[12.5px] font-medium">{expandedRow.caseId}</code>
                    <Badge tone={caseTag(expandedRow).tone}>{caseTag(expandedRow).label}</Badge>
                    <button
                      type="button"
                      onClick={() => onToggleCase(expandedRow.caseId)}
                      className="ml-auto text-xs text-inkmuted hover:text-ink"
                    >
                      收起
                    </button>
                  </div>
                  {renderRowDetail(expandedRow)}
                </div>
              )}
            </CardContent>
            {resources.length > 0 && (
              <div className="flex flex-wrap gap-x-7 gap-y-1 border-t border-dashed border-railline px-5 py-3.5 text-[12.5px] text-inkmuted">
                {resources.map((item) => (
                  <span key={item.label}>
                    {item.label} <b className="font-semibold tabular-nums text-ink">{item.value}</b>
                  </span>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {trend && trend.values.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>有效判定成功率 · 近 {trend.values.length} 场</CardTitle>
                <CardDescription>{trend.caption}</CardDescription>
              </CardHeader>
              <CardContent>
                <TrendSparkline values={trend.values} />
                <p className="mt-1 text-[11.5px] text-inkmuted">{trend.note}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>最近运行</CardTitle>
                <CardDescription>按创建时间倒序 · 点击切换总览</CardDescription>
              </div>
              <button
                type="button"
                onClick={onOpenDetails}
                className="text-xs text-inkmuted hover:text-ink"
              >
                全部记录
              </button>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="flex flex-col">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => onSelectJob(run.id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 border-b border-railline px-1 py-2.5 text-left text-[13px] last:border-b-0',
                        run.selected && 'rounded-lg bg-railbg',
                      )}
                    >
                      <span
                        className={cn('h-2 w-2 flex-none rounded-full', STATUS_DOT[run.status])}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{run.datasetName}</span>
                        <span className="block truncate text-[11.5px] text-inkmuted">
                          {run.caption}
                        </span>
                        <span className="mt-1 block">
                          <MiniStack counts={run.stack} />
                        </span>
                      </span>
                      <span className="flex-none text-[12.5px] tabular-nums text-inkmuted">
                        {run.metric}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>运行上下文</CardTitle>
              <CardDescription>冻结配置与能力边界</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              {context.map((item) => (
                <div
                  key={item.label}
                  className="flex items-baseline justify-between gap-3 text-[12.5px]"
                >
                  <span className="flex-none text-inkmuted">{item.label}</span>
                  <span className="truncate text-right font-medium">{item.value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function LegendItem({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('h-2.5 w-2.5 rounded-sm', color)} aria-hidden />
      {label} <b className="font-semibold tabular-nums">{value}</b>
    </span>
  )
}

function percent(value: number | null) {
  return value === null ? '暂无' : `${value}%`
}
