import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CodeDen · 评测工作台',
  description: 'Trace 审核与离线评测',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
