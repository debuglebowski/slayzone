import { ChevronDown, ShieldCheck, Eye, AlertTriangle, Zap } from 'lucide-react'
import { cn } from './utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './dropdown-menu'

/** An opaque, provider-specific permission/runtime mode id. */
export type AgentMode = string

/** Capability info for the `auto` mode (Max/Team/Enterprise + opt-in). */
export interface AutoModeCapability {
  eligible: boolean
  optedIn: boolean
}

interface ModeMeta {
  label: string
  short: string
  description: string
  icon: typeof ShieldCheck
  /** Tailwind classes for chip background + foreground. */
  chip: string
  /** Hover background for trigger. */
  chipHover: string
  /** Foreground-only color for text variant. */
  text: string
}

const SKY = {
  chip: 'bg-sky-500/15 text-sky-600 dark:text-sky-300 ring-sky-500/30',
  chipHover: 'hover:bg-sky-500/25',
  text: 'text-sky-600 dark:text-sky-300'
}
const EMERALD = {
  chip: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 ring-emerald-500/30',
  chipHover: 'hover:bg-emerald-500/25',
  text: 'text-emerald-600 dark:text-emerald-300'
}
const AMBER = {
  chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30',
  chipHover: 'hover:bg-amber-500/25',
  text: 'text-amber-700 dark:text-amber-300'
}

/**
 * Mode metadata keyed by mode id. Covers both the Claude permission modes
 * (plan/auto-accept/auto/bypass) and the Codex runtime modes
 * (approval-required/auto-accept-edits/full-access).
 */
const MODE_META: Record<string, ModeMeta> = {
  // ---- Claude ----
  plan: {
    label: 'Plan mode',
    short: 'Plan',
    description: 'Read-only — investigation phase. No edits, no shell.',
    icon: Eye,
    ...SKY
  },
  'auto-accept': {
    label: 'Auto-accept edits',
    short: 'Auto-accept',
    description: 'Edits and tool calls auto-approved. Recommended default.',
    icon: ShieldCheck,
    ...EMERALD
  },
  auto: {
    label: 'Auto mode',
    short: 'Auto',
    description: 'Continuous autonomous execution. Requires Max/Team/Enterprise + opt-in.',
    icon: Zap,
    chip: 'bg-violet-500/15 text-violet-600 dark:text-violet-300 ring-violet-500/30',
    chipHover: 'hover:bg-violet-500/25',
    text: 'text-violet-600 dark:text-violet-300'
  },
  bypass: {
    label: 'Bypass permissions',
    short: 'Bypass',
    description: 'All permission checks skipped. Use with caution.',
    icon: AlertTriangle,
    ...AMBER
  },
  // ---- Codex ----
  'approval-required': {
    label: 'Approval required',
    short: 'Approval',
    description: 'Read-only sandbox — asks before running commands or edits.',
    icon: Eye,
    ...SKY
  },
  'auto-accept-edits': {
    label: 'Auto-accept edits',
    short: 'Auto-accept',
    description: 'Edits and commands in the workspace auto-approved.',
    icon: ShieldCheck,
    ...EMERALD
  },
  'full-access': {
    label: 'Full access',
    short: 'Full access',
    description: 'All actions auto-approved, no sandbox. Use with caution.',
    icon: AlertTriangle,
    ...AMBER
  }
}

const FALLBACK_META: ModeMeta = {
  label: 'Mode',
  short: 'Mode',
  description: '',
  icon: ShieldCheck,
  ...EMERALD
}

const CLAUDE_MODE_ORDER: AgentMode[] = ['plan', 'auto-accept', 'auto', 'bypass']

/**
 * Cycle to the next mode, wrapping around. `order` overrides the default
 * Claude list (e.g. the Codex mode set). When using the Claude list, `auto`
 * is skipped unless `autoEnabled`.
 */
export function nextAgentMode(
  mode: AgentMode,
  autoEnabled = false,
  order?: AgentMode[]
): AgentMode {
  const list =
    order ?? (autoEnabled ? CLAUDE_MODE_ORDER : CLAUDE_MODE_ORDER.filter((m) => m !== 'auto'))
  const i = list.indexOf(mode)
  if (i === -1) return list[0]
  return list[(i + 1) % list.length]
}

export interface AgentModePillProps {
  mode: AgentMode
  onChange: (next: AgentMode) => void
  disabled?: boolean
  /** Compact variant — icon + short label only. */
  compact?: boolean
  /** Visual style. `pill` = colored chip (default). `text` = plain inline text. */
  variant?: 'pill' | 'text'
  className?: string
  /**
   * Ordered mode ids to offer. Defaults to the Claude permission modes; the
   * codex-chat caller passes its own runtime-mode set. When omitted, the
   * `auto` option is gated by `autoCapability`.
   */
  modes?: AgentMode[]
  /**
   * Auto-mode capability (Claude only). When omitted or `eligible: false`, the
   * `auto` option is hidden. When eligible but not opted in, it's shown
   * disabled with an opt-in hint. Ignored when `modes` is supplied explicitly.
   */
  autoCapability?: AutoModeCapability
}

export function AgentModePill({
  mode,
  onChange,
  disabled,
  compact,
  variant = 'pill',
  className,
  modes,
  autoCapability
}: AgentModePillProps) {
  const meta = MODE_META[mode] ?? FALLBACK_META
  const Icon = meta.icon
  const visibleModes =
    modes ?? CLAUDE_MODE_ORDER.filter((m) => m !== 'auto' || autoCapability?.eligible === true)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1 transition-colors',
          variant === 'pill'
            ? cn(
                'gap-1.5 rounded-full ring-1 px-2 py-0.5 text-[11px] font-medium',
                meta.chip,
                meta.chipHover
              )
            : cn('rounded px-1 py-0.5 text-[10px] hover:bg-muted/60', meta.text),
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
        title={meta.description}
        aria-label={`Agent mode: ${meta.label}`}
      >
        <Icon className="size-3" />
        <span>{compact ? meta.short : meta.label}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {visibleModes.map((m) => {
          const itemMeta = MODE_META[m] ?? FALLBACK_META
          const ItemIcon = itemMeta.icon
          const selected = m === mode
          // `auto` is selectable only when eligible AND opted in. Eligible-but-not-opted-in
          // surfaces the option disabled with an opt-in hint instead of hiding it.
          const itemDisabled = m === 'auto' && autoCapability?.optedIn !== true
          const description =
            m === 'auto' && autoCapability && !autoCapability.optedIn
              ? 'Run `claude` once and accept the auto-mode prompt to enable.'
              : itemMeta.description
          return (
            <DropdownMenuItem
              key={m}
              disabled={itemDisabled}
              onSelect={(e) => {
                if (itemDisabled) {
                  e.preventDefault()
                  return
                }
                if (m !== mode) onChange(m)
              }}
              className={cn(
                'flex items-start gap-2 py-2',
                selected && 'bg-accent/40',
                itemDisabled && 'opacity-50'
              )}
            >
              <ItemIcon className="size-4 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{itemMeta.label}</div>
                <div className="text-[11px] text-muted-foreground leading-snug">{description}</div>
              </div>
              {selected && (
                <span className="text-[10px] text-muted-foreground self-center">current</span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
