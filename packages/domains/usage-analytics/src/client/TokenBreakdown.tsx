import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { AnalyticsSummary } from '../shared/types'
import { formatTokens, TOOLTIP_STYLE, TICK_STYLE } from './chart-theme'

const COLORS: Record<string, string> = {
  Output: '#8b5cf6',
  Input: '#3b82f6',
  'Cache Read': '#22c55e',
  'Cache Write': '#f59e0b'
}

interface Props {
  data: AnalyticsSummary
}

export function TokenBreakdown({ data }: Props) {
  const items = [
    { name: 'Output', tokens: data.totalOutputTokens },
    { name: 'Input', tokens: data.totalInputTokens },
    { name: 'Cache Read', tokens: data.totalCacheReadTokens },
    { name: 'Cache Write', tokens: data.totalCacheWriteTokens }
  ].filter((d) => d.tokens > 0)

  if (items.length === 0) {
    return (
      <div className="rounded-lg border bg-surface-2 p-4">
        <p className="text-sm font-medium text-muted-foreground mb-3">Token Breakdown</p>
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          No data
        </div>
      </div>
    )
  }

  const chartData = items.map((d) => ({ ...d, fill: COLORS[d.name] ?? '#6b7280' }))

  return (
    <div className="rounded-lg border bg-surface-2 p-4">
      <p className="text-sm font-medium text-muted-foreground mb-3">Token Breakdown</p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
          <XAxis
            dataKey="name"
            tick={TICK_STYLE}
            angle={-30}
            textAnchor="end"
            interval={0}
            height={60}
          />
          <YAxis tick={TICK_STYLE} tickFormatter={(v) => formatTokens(v)} />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
            contentStyle={TOOLTIP_STYLE}
            formatter={(value) => [formatTokens(Number(value)), undefined]}
          />
          <Bar dataKey="tokens" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
