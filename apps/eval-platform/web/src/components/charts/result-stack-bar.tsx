'use client'

import { useMemo } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import { EChart } from './echarts'

export type ResultCounts = { pass: number; fail: number; unknown: number; pending: number }

const COLORS = {
  pass: '#22a06b',
  fail: '#d64545',
  unknown: '#9aa5b1',
  pending: '#e8ecef',
} as const

/** 四色堆叠条：一条图同时表达 P/F/U/M 与进度，绿色段内显示计划通过占比。 */
export function ResultStackBar({ counts }: { counts: ResultCounts }) {
  const total = counts.pass + counts.fail + counts.unknown + counts.pending
  const option = useMemo<EChartsCoreOption>(() => {
    const passShare = total > 0 ? Math.round((counts.pass / total) * 100) : 0
    return {
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      // 关闭入场动画：避免截图/瞬态帧呈现与图例不一致的中间宽度。
      animation: false,
      xAxis: { type: 'value', show: false, min: 0, max: total || 1 },
      yAxis: { type: 'category', data: [''], show: false },
      series: (
        [
          ['pass', counts.pass, passShare > 0 ? `${passShare}%` : ''],
          ['fail', counts.fail, ''],
          ['unknown', counts.unknown, ''],
          ['pending', counts.pending, ''],
        ] as const
      ).map(([key, value, label]) => ({
        type: 'bar',
        stack: 'result',
        barWidth: 30,
        data: [value],
        itemStyle: { color: COLORS[key], borderRadius: 0 },
        label: {
          show: Boolean(label),
          position: 'insideLeft',
          color: '#ffffff',
          fontSize: 12,
          fontWeight: 600,
          formatter: label,
        },
      })),
    }
  }, [counts, total])

  return (
    <div
      className="h-[34px] w-full overflow-hidden rounded-lg"
      aria-label="结果分布 P/F/U/M 堆叠条"
    >
      <EChart option={option} />
    </div>
  )
}

export { COLORS as RESULT_COLORS }
