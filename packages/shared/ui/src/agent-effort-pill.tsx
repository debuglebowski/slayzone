import { Brain, ChevronDown, Gauge, Zap } from 'lucide-react'
import { cn } from './utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './dropdown-menu'

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

interface EffortMeta {
  label: string
  short: string
  description: string
}

const EFFORT_META: Record<AgentEffort, EffortMeta> = {
  low: {
    label: 'Low',
    short: 'Low',
    description: 'Minimal reasoning. Fastest, cheapest.'
  },
  medium: {
    label: 'Medium',
    short: 'Medium',
    description: 'Balanced reasoning depth.'
  },
  high: {
    label: 'High',
    short: 'High',
    description: 'Deeper reasoning. Slower, higher cost.'
  },
  xhigh: {
    label: 'Extra-high',
    short: 'XHigh',
    description: 'Extended reasoning depth.'
  },
  max: {
    label: 'Max',
    short: 'Max',
    description: 'Maximum reasoning. Slowest, highest cost.'
  }
}

const EFFORT_ORDER: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

interface FastModeMeta {
  label: string
  description: string
  Icon: typeof Zap
}

/** Normal (false) / Fast (true) — Codex Fast Mode section. */
const FAST_MODE_META: Record<'normal' | 'fast', FastModeMeta> = {
  normal: {
    label: 'Normal',
    description: 'Standard delivery speed.',
    Icon: Gauge
  },
  fast: {
    label: 'Fast',
    description: 'Codex Fast Mode — ~1.5× faster delivery, higher credit usage.',
    Icon: Zap
  }
}

/**
 * One reasoning effort a model accepts, as the provider lists it (Codex
 * `model/list`: any string, e.g. `minimal`).
 */
export interface AgentEffortLevel {
  id: string
  label: string
  description?: string
}

/** The Claude levels, in order, as pill levels. */
const CLAUDE_LEVELS: AgentEffortLevel[] = EFFORT_ORDER.map((id) => ({
  id,
  label: EFFORT_META[id].label,
  description: EFFORT_META[id].description
}))

/** The effort levels in order, with the picker's names. */
export function agentEffortOptions(): Array<{ id: AgentEffort; label: string }> {
  return EFFORT_ORDER.map((id) => ({ id, label: EFFORT_META[id].label }))
}

export interface AgentEffortPillProps {
  /** One of `levels`' ids (the Claude levels when `levels` is absent). */
  effort: string
  onChange: (next: string) => void
  /** The levels the current model accepts (provider-listed); absent: the Claude levels. */
  levels?: AgentEffortLevel[]
  disabled?: boolean
  compact?: boolean
  /** Visual style. `pill` = chip (default). `text` = plain inline text. */
  variant?: 'pill' | 'text'
  className?: string
  /**
   * When set, renders a separator + Normal/Fast section below the effort
   * levels. Used for `codex-chat` to expose Codex Fast Mode.
   */
  showFastMode?: boolean
  /** Current Fast Mode state. Required when `showFastMode` is set. */
  fastMode?: boolean
  /** Fast Mode change handler. Required when `showFastMode` is set. */
  onFastModeChange?: (next: boolean) => void
}

export function AgentEffortPill({
  effort,
  onChange,
  levels,
  disabled,
  compact,
  variant = 'pill',
  className,
  showFastMode,
  fastMode,
  onFastModeChange
}: AgentEffortPillProps) {
  const list = levels ?? CLAUDE_LEVELS
  const known = (EFFORT_META as Record<string, EffortMeta | undefined>)[effort]
  const listed = list.find((l) => l.id === effort)
  const meta: EffortMeta = levels
    ? {
        label: listed?.label ?? effort,
        short: listed?.label ?? effort,
        description: listed?.description ?? ''
      }
    : (known ?? { label: effort, short: effort, description: '' })
  const fastSection = showFastMode && onFastModeChange
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'inline-flex items-center transition-colors',
          variant === 'pill'
            ? 'gap-1.5 rounded-full ring-1 px-2 py-0.5 text-[11px] font-medium bg-muted/40 text-muted-foreground ring-border hover:bg-muted/60 hover:text-foreground'
            : 'gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
        title={meta.description}
        aria-label={`Reasoning effort: ${meta.label}`}
      >
        <Brain className="size-3" />
        <span>{compact ? meta.short : meta.label}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {list.map((lvl) => {
          const selected = lvl.id === effort
          return (
            <DropdownMenuItem
              key={lvl.id}
              onSelect={(e) => {
                if (lvl.id === effort) {
                  e.preventDefault()
                  return
                }
                onChange(lvl.id)
              }}
              className={cn('flex items-start gap-2 py-2', selected && 'bg-accent/40')}
            >
              <Brain className="size-4 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{lvl.label}</div>
                {lvl.description ? (
                  <div className="text-[11px] text-muted-foreground leading-snug">
                    {lvl.description}
                  </div>
                ) : null}
              </div>
              {selected && (
                <span className="text-[10px] text-muted-foreground self-center">current</span>
              )}
            </DropdownMenuItem>
          )
        })}
        {fastSection && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Speed
            </DropdownMenuLabel>
            {(['normal', 'fast'] as const).map((id) => {
              const itemMeta = FAST_MODE_META[id]
              const ItemIcon = itemMeta.Icon
              const isFast = id === 'fast'
              const selected = isFast === Boolean(fastMode)
              return (
                <DropdownMenuItem
                  key={id}
                  onSelect={(e) => {
                    if (selected) {
                      e.preventDefault()
                      return
                    }
                    onFastModeChange?.(isFast)
                  }}
                  className={cn('flex items-start gap-2 py-2', selected && 'bg-accent/40')}
                >
                  <ItemIcon className="size-4 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium">{itemMeta.label}</div>
                    <div className="text-[11px] text-muted-foreground leading-snug">
                      {itemMeta.description}
                    </div>
                  </div>
                  {selected && (
                    <span className="text-[10px] text-muted-foreground self-center">current</span>
                  )}
                </DropdownMenuItem>
              )
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
