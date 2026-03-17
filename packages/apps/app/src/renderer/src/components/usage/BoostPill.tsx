import { useEffect, useRef, useState } from 'react'
import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@slayzone/ui'

const PROMO_END = new Date('2026-03-29T07:59:00Z') // March 28 11:59 PM PT
const PEAK_START = 5 // 5 AM PT
const PEAK_END = 11  // 11 AM PT
const MAX_TIMER = 60 * 60_000 // 60 min cap to avoid drift

const theme = {
  boosted: 'bg-orange-700 text-white border-orange-700',
  regular: 'bg-muted text-muted-foreground border-border',
  barBoosted: 'bg-orange-700',
  barPeak: 'bg-muted',
  legendBoosted: 'bg-orange-700',
  legendPeak: 'bg-muted',
} as const

interface BoostStatus {
  isBoosted: boolean
  msUntilChange: number
  ptHour: number
  isWeekend: boolean
}

function getPtTime(now: Date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  })
  const parts = fmt.formatToParts(now)
  return {
    hour: Number(parts.find((p) => p.type === 'hour')?.value),
    minute: Number(parts.find((p) => p.type === 'minute')?.value),
    weekday: parts.find((p) => p.type === 'weekday')?.value ?? '',
  }
}

function getBoostStatus(now: Date): BoostStatus {
  const { hour, minute, weekday } = getPtTime(now)
  const isWeekend = weekday === 'Sat' || weekday === 'Sun'

  if (isWeekend) {
    const daysUntilMon = weekday === 'Sat' ? 2 : 1
    const msLeft = daysUntilMon * 24 * 60 * 60_000 - (hour * 60 + minute) * 60_000 + PEAK_START * 60 * 60_000
    return { isBoosted: true, msUntilChange: Math.min(msLeft, MAX_TIMER), ptHour: hour, isWeekend }
  }

  const isPeak = hour >= PEAK_START && hour < PEAK_END
  const nowMinutes = hour * 60 + minute

  if (isPeak) {
    const msLeft = (PEAK_END * 60 - nowMinutes) * 60_000
    return { isBoosted: false, msUntilChange: Math.min(msLeft, MAX_TIMER), ptHour: hour, isWeekend }
  }

  if (hour < PEAK_START) {
    const msLeft = (PEAK_START * 60 - nowMinutes) * 60_000
    return { isBoosted: true, msUntilChange: Math.min(msLeft, MAX_TIMER), ptHour: hour, isWeekend }
  }

  const msLeft = ((24 - hour + PEAK_START) * 60 - minute) * 60_000
  return { isBoosted: true, msUntilChange: Math.min(msLeft, MAX_TIMER), ptHour: hour, isWeekend }
}

function buildTimeline(ptHour: number, isWeekend: boolean) {
  return Array.from({ length: 24 }, (_, i) => ({
    isBoosted: isWeekend || i < PEAK_START || i >= PEAK_END,
    isCurrent: i === ptHour,
  }))
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  const days = Math.floor(hrs / 24)
  return `${days}d ${hrs % 24}h`
}

function useBoostStatus() {
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<BoostStatus>({ isBoosted: false, msUntilChange: 0, ptHour: 0, isWeekend: false })
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    if (Date.now() >= PROMO_END.getTime()) return

    window.api.settings.get('default_terminal_mode').then((mode) => {
      if (!mode || !mode.toLowerCase().includes('claude')) return
      setVisible(true)

      const tick = () => {
        const now = new Date()
        if (now >= PROMO_END) {
          setVisible(false)
          return
        }
        const s = getBoostStatus(now)
        setStatus(s)
        timerRef.current = setTimeout(tick, Math.max(s.msUntilChange, 1000))
      }
      tick()
    })

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return { visible, ...status }
}

const HOUR_LABELS = [0, 6, 12, 18] as const

function Timeline({ ptHour, isWeekend }: { ptHour: number; isWeekend: boolean }) {
  const slots = buildTimeline(ptHour, isWeekend)
  return (
    <div className="space-y-1.5">
      <div className="flex gap-px w-full">
        {slots.map((s, i) => (
          <div key={i} className="relative flex-1 flex flex-col items-center">
            <div className={cn('w-full h-2 rounded-sm', s.isBoosted ? theme.barBoosted : theme.barPeak)} />
            {s.isCurrent && (
              <div className="absolute -bottom-2.5 size-0 border-l-[4px] border-r-[4px] border-b-[5px] border-transparent border-b-foreground" />
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-between items-center pt-1">
        <div className="flex gap-3 text-[10px] text-muted-foreground">
          {HOUR_LABELS.map((h) => (
            <span key={h}>{h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}</span>
          ))}
        </div>
        <div className="flex gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className={cn('inline-block w-2 h-2 rounded-sm', theme.legendBoosted)} /> 2×</span>
          {!isWeekend && <span className="flex items-center gap-1"><span className={cn('inline-block w-2 h-2 rounded-sm', theme.legendPeak)} /> 1×</span>}
        </div>
      </div>
    </div>
  )
}

export function BoostPill() {
  const { visible, isBoosted, msUntilChange, ptHour, isWeekend } = useBoostStatus()
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(null)

  const handleEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const handleLeave = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 200)
  }

  if (!visible) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          className={cn(
            'h-6 px-2 text-xs font-medium rounded-full border transition-colors inline-flex items-center',
            isBoosted ? theme.boosted : theme.regular,
          )}
        >
          {isBoosted ? '2× Usage' : 'Regular Usage'}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-80 p-5 space-y-5"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {isBoosted ? '2× Boost Active' : 'Peak Hours (1×)'}
          </span>
          <a
            href="https://support.claude.com/en/articles/13163666-holiday-2025-usage-promotion"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors underline"
          >
            Learn more
          </a>
        </div>
        <Timeline ptHour={ptHour} isWeekend={isWeekend} />
        <p className="text-xs text-muted-foreground">
          {isWeekend
            ? 'Weekends are always 2×.'
            : 'Anthropic doubles Claude usage outside peak hours (5–11 AM PT weekdays).'}
          {' '}
          {isBoosted
            ? `Peak starts in ${formatCountdown(msUntilChange)}.`
            : `Boost resumes in ${formatCountdown(msUntilChange)}.`}
        </p>
      </PopoverContent>
    </Popover>
  )
}
