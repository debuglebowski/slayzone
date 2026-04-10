import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Circle, RefreshCw } from 'lucide-react'
import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@slayzone/ui'
import type { ProviderUsage, UsageWindow } from '@slayzone/terminal/shared'

type PinnedBars = Record<string, string[]>

interface UsagePopoverProps {
  data: ProviderUsage[]
  onRefresh: (force?: boolean) => void
}

function barColor(pct: number) {
  if (pct >= 85) return 'bg-red-500'
  if (pct >= 60) return 'bg-yellow-500'
  return 'bg-green-500'
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  const days = Math.floor(hrs / 24)
  return `${days}d ${hrs % 24}h`
}

function formatReset(iso: string): string {
  return formatDuration(new Date(iso).getTime() - Date.now())
}

function formatAgo(epochMs: number): string {
  return formatDuration(Date.now() - epochMs)
}

function InlineBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="text-[10px] text-muted-foreground leading-none">{label}</span>
      <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', barColor(pct))}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  )
}

function WindowRow({
  label,
  w,
  pinned,
  onTogglePin,
}: {
  label: string
  w: UsageWindow
  pinned?: boolean
  onTogglePin?: () => void
}) {
  const reset = formatReset(w.resetsAt)
  return (
    <div className="flex items-center gap-2">
      {onTogglePin && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          className={cn(
            'shrink-0 transition-colors outline-none',
            pinned ? 'text-foreground' : 'text-muted-foreground/30 hover:text-muted-foreground/60',
          )}
        >
          <Circle className={cn('size-2.5', pinned && 'fill-current')} />
        </button>
      )}
      <span className="text-xs text-muted-foreground w-8 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', barColor(w.utilization))}
          style={{ width: `${Math.min(w.utilization, 100)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums w-8 text-right">{Math.round(w.utilization)}%</span>
      <span className="text-[10px] text-muted-foreground w-16 shrink-0 text-right">
        {reset}
      </span>
    </div>
  )
}

function ProviderSection({
  usage,
  pinned,
  onTogglePin,
}: {
  usage: ProviderUsage
  pinned: string[]
  onTogglePin: (key: string) => void
}) {
  const hasWindows = usage.windows.length > 0
  const isStale = hasWindows && usage.error !== null
  const staleAge = isStale ? formatAgo(usage.fetchedAt) : null

  // Error-only (no cached data to show)
  if (usage.error && !hasWindows) {
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium">{usage.label}</div>
        <div className="flex items-start gap-1.5 text-xs text-yellow-500">
          <AlertTriangle className="size-3 shrink-0 mt-0.5" />
          <span>{usage.error}</span>
        </div>
      </div>
    )
  }

  if (!hasWindows) return null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium flex-1">{usage.label}</span>
        <span className="text-[10px] text-muted-foreground w-16 shrink-0 text-right">Resets in</span>
      </div>
      {isStale && (
        <div className="flex items-center gap-1 text-[10px] text-yellow-500/80">
          <AlertTriangle className="size-2.5 shrink-0" />
          <span>{usage.error} · {staleAge} old</span>
        </div>
      )}
      {[...usage.windows].sort((a, b) => a.label.localeCompare(b.label)).map((w) => (
        <WindowRow
          key={w.key}
          label={w.label}
          w={w}
          pinned={pinned.includes(w.key)}
          onTogglePin={() => onTogglePin(w.key)}
        />
      ))}
    </div>
  )
}

function defaultPins(data: ProviderUsage[]): PinnedBars {
  const pins: PinnedBars = {}
  for (const p of data) {
    if (p.windows.length === 0) continue
    pins[p.provider] = [p.windows[0].key]
  }
  return pins
}

function totalPinCount(pins: PinnedBars): number {
  return Object.values(pins).reduce((sum, arr) => sum + arr.length, 0)
}

export function UsagePopover({ data, onRefresh }: UsagePopoverProps) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const [pinned, setPinned] = useState<PinnedBars | null>(null)

  useEffect(() => {
    window.api.settings.get('usage_pinned_bars').then((raw) => {
      if (raw) {
        try {
          setPinned(JSON.parse(raw))
        } catch {
          /* ignore corrupt */
        }
      }
    })
  }, [])

  // Resolve effective pins: saved or default (first window per provider)
  const effectivePinned = pinned ?? defaultPins(data)

  const togglePin = useCallback(
    (provider: string, windowKey: string) => {
      setPinned((prev) => {
        const base = prev ?? defaultPins(data)
        const next = { ...base }
        const arr = [...(next[provider] ?? [])]
        const idx = arr.indexOf(windowKey)
        if (idx >= 0) {
          // Prevent unpinning the very last one across all providers
          if (totalPinCount(next) <= 1) return base
          arr.splice(idx, 1)
          if (arr.length === 0) delete next[provider]
          else next[provider] = arr
        } else {
          next[provider] = [...arr, windowKey]
        }
        window.api.settings.set('usage_pinned_bars', JSON.stringify(next))
        return next
      })
    },
    [data],
  )

  const handleEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const handleLeave = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 200)
  }

  const inlineBars: { label: string; pct: number }[] = data.flatMap((p) => {
    const keys = effectivePinned[p.provider]
    if (!keys) return []
    return keys
      .map((k) => {
        const w = p.windows.find((w) => w.key === k)
        return w ? { label: `${p.label} ${w.label}`, pct: w.utilization } : null
      })
      .filter(Boolean) as { label: string; pct: number }[]
  }).sort((a, b) => a.label.localeCompare(b.label))

  const hasError = data.some((p) => p.error !== null)

  if (data.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-2 h-7 px-1 transition-colors text-muted-foreground hover:text-foreground"
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          {hasError && (
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertTriangle className="size-3 text-yellow-500 shrink-0" />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs max-w-64">
                {data.filter((p) => p.error).map((p) => `${p.label}: ${p.error}`).join('\n')}
              </TooltipContent>
            </Tooltip>
          )}
          {inlineBars.length > 0 ? (
            inlineBars.map((b) => <InlineBar key={b.label} pct={b.pct} label={b.label} />)
          ) : (
            <span className="text-[10px]">Usage</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-72 p-3 space-y-3"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {[...data].sort((a, b) => a.label.localeCompare(b.label)).map((p) => (
          <ProviderSection
            key={p.provider}
            usage={p}
            pinned={effectivePinned[p.provider] ?? []}
            onTogglePin={(key) => togglePin(p.provider, key)}
          />
        ))}
        <div className="flex items-center justify-between pt-1 border-t">
          <span className="text-[10px] text-muted-foreground">
            {data[0]?.fetchedAt
              ? `Updated ${formatAgo(data[0].fetchedAt)} ago`
              : ''}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRefresh(true)
            }}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className="size-3" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
