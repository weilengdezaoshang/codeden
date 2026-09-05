'use client'

import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, ScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { cn } from '../../lib/utils'

echarts.use([BarChart, ScatterChart, GridComponent, TooltipComponent, CanvasRenderer])

/**
 * 轻量 ECharts React 包装：按需注册图表与组件，容器尺寸变化时自动重绘。
 */
export function EChart({
  option,
  className,
  style,
  onEvents,
}: {
  option: EChartsCoreOption
  className?: string
  style?: React.CSSProperties
  onEvents?: Record<string, (params: never) => void>
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!containerRef.current) {
      return
    }
    const chart = echarts.init(containerRef.current)
    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(containerRef.current)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true })
  }, [option])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onEvents) {
      return
    }
    for (const [name, handler] of Object.entries(onEvents)) {
      chart.on(name, handler as never)
    }
    return () => {
      for (const name of Object.keys(onEvents)) {
        chart.off(name)
      }
    }
  }, [onEvents])

  return <div ref={containerRef} className={cn('h-full w-full', className)} style={style} />
}
