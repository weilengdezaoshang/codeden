'use client'

import { useMemo } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import { EChart } from './echarts'

export type DatasetSizeItem = { name: string; count: number; imported: boolean }

/** 数据集规模对比：横向条形图，未导入的评测集以灰色空心显示。 */
export function DatasetSizeChart({ items }: { items: DatasetSizeItem[] }) {
  const option = useMemo<EChartsCoreOption>(() => {
    const sorted = [...items].sort((left, right) => right.count - left.count)
    return {
      grid: { left: 8, right: 40, top: 4, bottom: 4, containLabel: true },
      xAxis: { type: 'value', show: false },
      yAxis: {
        type: 'category',
        inverse: true,
        data: sorted.map((item) => item.name),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 12, color: '#1c2430', width: 150, overflow: 'truncate' },
      },
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (params: { name: string; value: number }) =>
          `${params.name}：${params.value} 道题`,
      },
      series: [
        {
          type: 'bar',
          barWidth: 12,
          data: sorted.map((item) => ({
            value: item.count,
            itemStyle: {
              color: item.imported ? '#2563eb' : 'transparent',
              borderColor: item.imported ? 'transparent' : '#c3ccd6',
              borderWidth: item.imported ? 0 : 1.5,
              borderType: 'dashed',
              borderRadius: [0, 6, 6, 0],
            },
          })),
          label: {
            show: true,
            position: 'right',
            fontSize: 11,
            color: '#6b7684',
            formatter: (params: { value: number }) =>
              params.value > 0 ? `${params.value}` : '未导入',
          },
        },
      ],
    }
  }, [items])

  if (items.length === 0) {
    return null
  }
  const height = items.length * 32 + 16
  return (
    <div
      style={{ height }}
      role="img"
      aria-label="各评测集题目数量对比，蓝色为已导入，空心为未导入"
    >
      <EChart option={option} />
    </div>
  )
}
