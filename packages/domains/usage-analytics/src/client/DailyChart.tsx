import { useState, useMemo } from 'react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import type { DailySummary, DateRange } from '../shared/types'
import { PROVIDER_USAGE_SUPPORT } from '../shared/types'
import { cn } from '@slayzone/ui'
import { formatTokens, PROVIDER_COLORS, PROVIDER_FALLBACK_COLOR, TOOLTIP_STYLE, TICK_STYLE, GRID_STYLE } from './chart-theme'

function getDateRangeStart(range: DateRange): Date {
  const now = new Date()
  switch (range) {
    case '7d': return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
    case '30d': return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
    case '90d': return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90)
    case 'all': return new Date(0)
  }
}

function toDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

interface Props {
  data: DailySummary[]
  range: DateRange
}

export function DailyChart({ data, range }: Props) {
  const [cumulative, setCumulative] = useState(false)

  const { chartData, providers } = useMemo(() => {
    const providers = [...new Set(data.map((d) => d.provider))]
    const byDate = new Map<string, Record<string, number>>()

    for (const d of data) {
      const existing = byDate.get(d.date) ?? {}
      existing[d.provider] = (existing[d.provider] ?? 0) + d.totalTokens
      byDate.set(d.date, existing)
    }

    const rangeStart = getDateRangeStart(range)
    const dataStart = data.length > 0 ? new Date(data.reduce((min, d) => d.date < min ? d.date : min, data[0].date)) : rangeStart
    const start = range === 'all' ? dataStart : rangeStart
    const today = new Date()
    const allDates: string[] = []
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      allDates.push(toDateKey(d))
    }

    let chartData: Record<string, string | number>[]
    if (cumulative) {
      const runningTotal: Record<string, number> = {}
      chartData = allDates.map((date) => {
        const values = byDate.get(date) ?? {}
        for (const p of providers) {
          if (values[p] != null) {
            runningTotal[p] = (runningTotal[p] ?? 0) + values[p]
          }
        }
        return {
          date: date.slice(5),
          ...Object.fromEntries(providers.map((p) => [p, runningTotal[p] ?? 0])),
        }
      })
    } else {
      chartData = allDates.map((date) => {
        const values = byDate.get(date) ?? {}
        return {
          date: date.slice(5),
          ...Object.fromEntries(providers.map((p) => [p, values[p] ?? 0])),
        }
      })
    }

    return { chartData, providers }
  }, [data, cumulative, range])

  const title = cumulative ? 'Cumulative Tokens' : 'Daily Tokens'

  if (chartData.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm font-medium text-muted-foreground mb-3">{title}</p>
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          No data for this period
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className="flex items-center gap-3">
          {providers.map((provider) => (
            <div key={provider} className="flex items-center gap-1.5">
              <div className="size-2.5 rounded-full" style={{ backgroundColor: PROVIDER_COLORS[provider] ?? PROVIDER_FALLBACK_COLOR }} />
              <span className="text-xs text-muted-foreground">{provider}</span>
            </div>
          ))}
          <div className="flex rounded-md border bg-muted/30 p-0.5 ml-1">
            <button
              onClick={() => setCumulative(false)}
              className={cn(
                'px-2 py-0.5 text-xs font-medium rounded transition-colors',
                !cumulative ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Daily
            </button>
            <button
              onClick={() => setCumulative(true)}
              className={cn(
                'px-2 py-0.5 text-xs font-medium rounded transition-colors',
                cumulative ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Total
            </button>
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" {...GRID_STYLE} />
          <XAxis dataKey="date" tick={TICK_STYLE} />
          <YAxis
            tick={TICK_STYLE}
            tickFormatter={(v) => formatTokens(v)}
            domain={[0, 'auto']}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const [mm, dd] = (label as string).split('-')
              const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
              const dateLabel = `${monthNames[parseInt(mm, 10) - 1]} ${parseInt(dd, 10)}`
              return (
                <div style={TOOLTIP_STYLE}>
                  <p style={{ marginBottom: 4, fontWeight: 500 }}>{dateLabel}</p>
                  {payload.map((entry) => {
                    const name = PROVIDER_USAGE_SUPPORT[entry.dataKey as string]?.label ?? entry.dataKey
                    const value = entry.value as number
                    return (
                      <div key={entry.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: PROVIDER_COLORS[entry.dataKey as string] ?? PROVIDER_FALLBACK_COLOR, flexShrink: 0 }} />
                          {name}
                        </span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatTokens(value)}</span>
                      </div>
                    )
                  })}
                </div>
              )
            }}
          />
          {providers.map((provider) => (
            <Area
              key={provider}
              type="monotone"
              dataKey={provider}
              fill={PROVIDER_COLORS[provider] ?? PROVIDER_FALLBACK_COLOR}
              stroke={PROVIDER_COLORS[provider] ?? PROVIDER_FALLBACK_COLOR}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
