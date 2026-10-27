import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { ModelSummary } from '../shared/types'
import { formatTokens, TOOLTIP_STYLE, TICK_STYLE } from './chart-theme'

function shortenModel(model: string): string {
  return model.replace('claude-', '').replace(/-\d{8}$/, '')
}

interface Props {
  data: ModelSummary[]
}

export function ModelBreakdown({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border bg-surface-2 p-4">
        <p className="text-sm font-medium text-muted-foreground mb-3">By Model</p>
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          No data
        </div>
      </div>
    )
  }

  const chartData = data.slice(0, 8).map((d) => ({
    ...d,
    shortModel: shortenModel(d.model)
  }))

  return (
    <div className="rounded-lg border bg-surface-2 p-4">
      <p className="text-sm font-medium text-muted-foreground mb-3">By Model</p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
          <XAxis
            dataKey="shortModel"
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
          <Bar dataKey="totalTokens" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
