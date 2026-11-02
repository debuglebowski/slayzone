import { useState } from 'react'
import { ChevronDown, Gauge, Zap } from 'lucide-react'
import { cn } from './utils'
import { PickerDefaultTag, PickerInfoButton, PickerInfoPane } from './picker-info'
import { AgentEffortIllustration } from './agent-picker-illustrations'
import { effortLook, NEUTRAL_TONE, TONES } from './picker-tones'
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

/** Info-pane text per known level (provider-listed levels fall back to their own description). */
const EFFORT_DETAILS: Record<string, string> = {
  low: 'Minimal thinking before answering. Fastest and cheapest; fine for simple, well-defined changes.',
  medium: 'Moderate thinking. A balance between speed and quality.',
  high: 'Thinks more before acting. Better on tricky problems; slower and more expensive.',
  xhigh: 'Extended thinking for hard problems. Noticeably slower and more expensive.',
  max: 'The most thinking the model allows. Slowest and highest cost; for the hardest problems.'
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
  /** The user's default effort; its row is tagged "default". */
  defaultEffort?: string
  /** When set, the info pane offers "Set as default" for the level it explains. */
  onSetDefault?: (effort: string) => void
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
  onFastModeChange,
  defaultEffort,
  onSetDefault
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
  // Level whose info pane is open (the popup grows a second column), or null.
  const [infoId, setInfoId] = useState<string | null>(null)
  const info = infoId ? list.find((l) => l.id === infoId) : undefined
  const look = effortLook(
    list.findIndex((l) => l.id === effort),
    list.length
  )
  const infoLook = info ? effortLook(list.indexOf(info), list.length) : null
  return (
    <DropdownMenu onOpenChange={(open) => !open && setInfoId(null)}>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'inline-flex items-center transition-colors',
          variant === 'pill'
            ? cn(
                'gap-1.5 rounded-full ring-1 px-2 py-0.5 text-[11px] font-medium',
                look.tone.chip,
                look.tone.chipHover
              )
            : cn('gap-1 rounded px-1 py-0.5 text-[10px] hover:bg-muted/60', look.tone.text),
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
        title={meta.description}
        aria-label={`Reasoning effort: ${meta.label}`}
      >
        <look.icon className="size-3" />
        <span>{compact ? meta.short : meta.label}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="flex w-auto p-0">
        <div className="w-56 p-1">
          {/* Most reasoning first; colors/icons keep each level's place in `list`. */}
          {list.toReversed().map((lvl, r) => {
            const selected = lvl.id === effort
            const rowLook = effortLook(list.length - 1 - r, list.length)
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
                className={cn('flex items-center gap-2 py-2', selected && rowLook.tone.chip)}
              >
                <rowLook.icon className={cn('size-3.5 shrink-0', rowLook.tone.text)} />
                <span
                  className={cn('flex-1 min-w-0 truncate text-xs', selected && 'font-semibold')}
                >
                  {lvl.label}
                </span>
                {lvl.id === defaultEffort && <PickerDefaultTag />}
                <PickerInfoButton
                  label={lvl.label}
                  active={infoId === lvl.id}
                  onToggle={() => setInfoId(infoId === lvl.id ? null : lvl.id)}
                />
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
                const rowTone = isFast ? TONES.amber : NEUTRAL_TONE
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
                    className={cn('flex items-start gap-2 py-2', selected && rowTone.chip)}
                  >
                    <ItemIcon className={cn('size-4 mt-0.5 shrink-0', rowTone.text)} />
                    <div className="flex-1 min-w-0">
                      <div className={cn('text-xs', selected ? 'font-semibold' : 'font-medium')}>
                        {itemMeta.label}
                      </div>
                      <div className="text-[11px] text-muted-foreground leading-snug">
                        {itemMeta.description}
                      </div>
                    </div>
                  </DropdownMenuItem>
                )
              })}
            </>
          )}
        </div>
        {info && infoLook && (
          <PickerInfoPane
            className={infoLook.tone.text}
            title={
              <>
                <infoLook.icon className="size-4 shrink-0" />
                {info.label}
              </>
            }
            details={
              EFFORT_DETAILS[info.id] ?? info.description ?? 'No description from the provider.'
            }
            isDefault={info.id === defaultEffort}
            onSetDefault={onSetDefault && (() => onSetDefault(info.id))}
          >
            <AgentEffortIllustration
              index={list.indexOf(info)}
              count={list.length}
              className="h-16 w-full"
            />
          </PickerInfoPane>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
