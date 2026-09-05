'use client'

import { useMemo } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import { EChart } from './echarts'
import type { ResultCounts } from './result-stack-bar'

export type CaseDotRow = ResultCounts & { caseId: string }

const ROW_HEIGHT = 36

/** 每题点阵：●通过 ●不通过 ○未判定 ◌未执行，一行一道题。 */
export function CaseDotMatrix({
  rows,
  onSelectCase,
}: {
  rows: CaseDotRow[]
  onSelectCase?: (caseId: string) => void
}) {
  const option = useMemo<EChartsCoreOption>(() => {
    const plannedMax = Math.max(
      1,
      ...rows.map((row) => row.pass + row.fail + row.unknown + row.pending),
    )
    const series = (
      [
        ['通过', '#22a06b', 0],
        ['不通过', '#d64545', 0],
        ['未判定', '#9aa5b1', 0],
        ['未执行', 'transparent', 1],
      ] as const
    ).map(([name, color, hollow], slot) => ({
      name,
      type: 'scatter',
      symbolSize: 13,
      symbol: 'circle',
      itemStyle: {
        color,
        borderColor: hollow ? '#c3ccd6' : 'transparent',
        borderWidth: hollow ? 1.5 : 0,
        borderType: hollow ? ('dashed' as const) : ('solid' as const),
      },
      data: rows.flatMap((row, rowIndex) => {
        const cells = [row.pass, row.fail, row.unknown, row.pending]
        const count = cells[slot] ?? 0
        return Array.from({ length: count }, (_, i) => ({
          value: [slotToX(row, slot, i), rowIndex],
          caseId: row.caseId,
        }))
      }),
    }))
    return {
      grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
      xAxis: {
        type: 'value',
        min: -0.7,
        max: plannedMax - 0.3,
        show: false,
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: rows.map((row) => row.caseId),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          color: '#1c2430',
          width: 220,
          overflow: 'truncate',
        },
      },
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (params: { data?: { caseId?: string; value?: [number, number] } }) => {
          const row = rows.find((item) => item.caseId === params.data?.caseId)
          if (!row) {
            return ''
          }
          const planned = row.pass + row.fail + row.unknown + row.pending
          return `<strong>${row.caseId}</strong><br/>通过 ${row.pass} · 不通过 ${row.fail} · 未判定 ${row.unknown} · 未执行 ${row.pending}（共 ${planned} 次）`
        },
      },
      series,
    }
  }, [rows])

  if (rows.length === 0) {
    return null
  }
  const height = rows.length * ROW_HEIGHT + 24
  const onEvents = onSelectCase
    ? {
        click: (params: { data?: { caseId?: string } }) => {
          if (params.data?.caseId) {
            onSelectCase(params.data.caseId)
          }
        },
      }
    : undefined
  return (
    <div
      style={{ height }}
      role="img"
      aria-label="每题成绩点阵，绿点为通过，红点为不通过，灰点为未判定，空心点为未执行"
    >
      <EChart option={option} onEvents={onEvents} />
    </div>
  )
}

/** 点的位置：四个分段连续排列，而不是按 x=序号散开，保持“一排 5 个点”的读感。 */
function slotToX(row: CaseDotRow, slot: number, indexInSlot: number) {
  const before = ([row.pass, row.fail, row.unknown] as number[])
    .slice(0, slot)
    .reduce((sum, value) => sum + value, 0)
  return before + indexInSlot
}
