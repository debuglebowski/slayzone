import { useEffect, useState, type ReactNode } from 'react'
import { Gauge } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger, ProgressRing, Slider, Tooltip, TooltipContent, TooltipTrigger, cn } from '@slayzone/ui'

const PRESETS = [0, 25, 50, 75, 100] as const

interface TaskProgressPopoverProps {
  value: number
  onCommit: (next: number) => void
  size?: number
  strokeWidth?: number
  rangeClassName?: string
  trackClassName?: string
  buttonClassName?: string
  label?: string
  align?: 'start' | 'center' | 'end'
  /** Override the trigger. If omitted, renders a small ring button. */
  children?: ReactNode
  /** When provided, wraps trigger in a Radix Tooltip. */
  tooltip?: ReactNode
}

export function TaskProgressPopover({
  value,
  onCommit,
  size = 14,
  strokeWidth = 2,
  rangeClassName,
  trackClassName,
  buttonClassName,
  label = 'Progress',
  align = 'start',
  children,
  tooltip,
}: TaskProgressPopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [local, setLocal] = useState(value)

  useEffect(() => {
    if (!open) setLocal(value)
  }, [value, open])

  const display = open ? local : value

  const commit = (next: number): void => {
    setLocal(next)
    onCommit(next)
  }

  const defaultTrigger = (
    <button
      type="button"
      aria-label={`${label}: ${Math.round(display)}%`}
      className={cn(
        'inline-flex items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
        buttonClassName,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <ProgressRing
        value={display}
        size={size}
        strokeWidth={strokeWidth}
        rangeClassName={rangeClassName}
        trackClassName={trackClassName}
      />
    </button>
  )

  const trigger = children ?? defaultTrigger

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      <PopoverContent
        className="w-72 p-4"
        align={align}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Gauge className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">{label}</span>
          </div>
          <div className="flex items-baseline gap-0.5 tabular-nums">
            <span className="text-2xl font-semibold leading-none">{Math.round(local)}</span>
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        </div>

        <Slider
          value={[local]}
          min={0}
          max={100}
          step={1}
          onValueChange={(next) => setLocal(next[0] ?? 0)}
          onValueCommit={(next) => onCommit(next[0] ?? 0)}
          aria-label={label}
        />

        <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground tabular-nums">
          <span>0%</span>
          <span>100%</span>
        </div>

        <div className="mt-3 grid grid-cols-5 gap-1">
          {PRESETS.map((p) => {
            const active = Math.round(local) === p
            return (
              <button
                key={p}
                type="button"
                onClick={() => commit(p)}
                aria-pressed={active}
                className={cn(
                  'h-7 rounded-md text-xs font-medium tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {p}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
