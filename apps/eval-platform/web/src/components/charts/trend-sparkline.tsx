'use client'

import { useMemo } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import { EChart } from './echarts'

/** 近 N 场同条件运行的迷你趋势柱，最后一根高亮。 */
export function TrendSparkline({ values, unit = '%' }: { values: number[]; unit?: string }) {
  const option = useMemo<EChartsCoreOption>(() => {
    return {
      grid: { left: 0, right: 0, top: 22, bottom: 0 },
      xAxis: { type: 'category', data: values.map((_, i) => `#${i + 1}`), show: false },
      yAxis: { type: 'value', show: false, min: 0, max: 100 },
      series: [
        {
          type: 'bar',
          barWidth: '55%',
          data: values.map((value, i) => ({
            value,
            itemStyle: {
              color: i === values.length - 1 ? '#2563eb' : '#cdd9f5',
              borderRadius: [4, 4, 0, 0],
            },
          })),
          label: {
            show: true,
            position: 'top',
            fontSize: 10.5,
            color: '#6b7684',
            formatter: (params: { value: number }) => `${params.value}${unit}`,
          },
        },
      ],
    }
  }, [values, unit])

  if (values.length === 0) {
    return null
  }
  return (
    <div className="h-[72px] w-full" role="img" aria-label={`最近 ${values.length} 场运行趋势`}>
      <EChart option={option} />
    </div>
  )
}
