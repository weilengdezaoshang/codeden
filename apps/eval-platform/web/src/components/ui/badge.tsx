import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-[#eef2f7] text-inkmuted',
        ok: 'bg-[#e5f5ec] text-[#157347]',
        vol: 'bg-[#fdeeee] text-[#b23a3a]',
        inc: 'bg-[#f0f2f5] text-inkmuted',
        warn: 'bg-[#fff6e0] text-[#b07800]',
        accent: 'bg-[#e8eefc] text-[#2563eb]',
        outline: 'border border-railline bg-white text-inkmuted',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
