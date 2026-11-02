import { useState } from 'react'
import { ChevronDown, ShieldCheck, ShieldQuestion, Eye, AlertTriangle, Zap } from 'lucide-react'
import { cn } from './utils'
import { AgentModeIllustration } from './agent-mode-illustration'
import { PickerDefaultTag, PickerInfoButton, PickerInfoPane } from './picker-info'
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
  /** Longer explanation shown in the info pane. */
  details: string
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

const INDIGO = {
  chip: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 ring-indigo-500/30',
  chipHover: 'hover:bg-indigo-500/25',
  text: 'text-indigo-600 dark:text-indigo-300'
}

/**
 * Mode metadata keyed by mode id. Covers both the Claude permission modes
 * (plan/ask/auto-accept/auto/bypass) and the Codex runtime modes
 * (approval-required/auto-accept-edits/full-access).
 */
const MODE_META: Record<string, ModeMeta> = {
  // ---- Claude ----
  plan: {
    label: 'Plan mode',
    short: 'Plan',
    description: 'Read-only — investigation phase. No edits, no shell.',
    details:
      'Claude reads files and explores, then writes a plan for you to approve. It does not edit your source until you approve the plan. Good for scoping a change before any code is touched.',
    icon: Eye,
    ...SKY
  },
  ask: {
    label: 'Ask before edits',
    short: 'Ask',
    description: 'Claude asks before each edit and command; you answer in the chat.',
    details:
      'Reads run without asking. Every edit and shell command waits for your approval, shown as a card in the chat. Best for sensitive work where you want to review each action.',
    icon: ShieldQuestion,
    ...INDIGO
  },
  'auto-accept': {
    label: 'Auto-accept edits',
    short: 'Auto-accept',
    description: 'Edits and tool calls auto-approved. Recommended default.',
    details:
      'File edits and common file commands (mkdir, touch, rm, mv, cp, sed) inside the project folder run without asking. Other shell commands, and anything outside the folder, still ask in the chat.',
    icon: ShieldCheck,
    ...EMERALD
  },
  auto: {
    label: 'Auto mode',
    short: 'Auto',
    description: 'Continuous autonomous execution. Requires Max/Team/Enterprise + opt-in.',
    details:
      'A separate classifier model reviews each action before it runs and blocks anything that goes beyond your request, such as force pushes, production deploys or downloading and running code. Needs an eligible account and model.',
    icon: Zap,
    chip: 'bg-violet-500/15 text-violet-600 dark:text-violet-300 ring-violet-500/30',
    chipHover: 'hover:bg-violet-500/25',
    text: 'text-violet-600 dark:text-violet-300'
  },
  bypass: {
    label: 'Bypass permissions',
    short: 'Bypass',
    description: 'All permission checks skipped. Use with caution.',
    details:
      'No permission prompts or safety checks: every tool call runs immediately, including writes to protected paths. Deny rules in your settings still apply. Use only in isolated environments such as containers or VMs.',
    icon: AlertTriangle,
    ...AMBER
  },
  // ---- Codex ----
  'approval-required': {
    label: 'Approval required',
    short: 'Approval',
    description: 'Read-only sandbox — asks before running commands or edits.',
    details:
      'Commands run in a read-only sandbox without network access. Codex asks before running anything not known to be safe, so nothing in your project changes without your approval.',
    icon: Eye,
    ...SKY
  },
  'auto-accept-edits': {
    label: 'Auto-accept edits',
    short: 'Auto-accept',
    description: 'Edits and commands in the workspace auto-approved.',
    details:
      'Codex edits files and runs commands inside the project folder without asking. Network access is off. It asks before anything outside the folder or anything that needs the network.',
    icon: ShieldCheck,
    ...EMERALD
  },
  'full-access': {
    label: 'Full access',
    short: 'Full access',
    description: 'All actions auto-approved, no sandbox. Use with caution.',
    details:
      'No sandbox and no approvals: Codex can read and write anywhere on disk and use the network. Use only in environments you trust.',
    icon: AlertTriangle,
    ...AMBER
  }
}

const FALLBACK_META: ModeMeta = {
  label: 'Mode',
  short: 'Mode',
  description: '',
  details: '',
  icon: ShieldCheck,
  ...EMERALD
}

const CLAUDE_MODE_ORDER: AgentMode[] = ['plan', 'ask', 'auto-accept', 'auto', 'bypass']

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

/** A mode's name as the picker shows it (the id when unknown). */
export function agentModeLabel(mode: AgentMode): string {
  return MODE_META[mode]?.label ?? mode
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
  /** The user's default mode; its row is tagged "default". */
  defaultMode?: AgentMode
  /** When set, the info pane offers "Set default" for the mode it explains. */
  onSetDefault?: (mode: AgentMode) => void
}

export function AgentModePill({
  mode,
  onChange,
  disabled,
  compact,
  variant = 'pill',
  className,
  modes,
  autoCapability,
  defaultMode,
  onSetDefault
}: AgentModePillProps) {
  const meta = MODE_META[mode] ?? FALLBACK_META
  const Icon = meta.icon
  // Mode whose info pane is open (the popup grows a second column), or null.
  const [infoMode, setInfoMode] = useState<AgentMode | null>(null)
  const infoMeta = infoMode ? (MODE_META[infoMode] ?? FALLBACK_META) : null
  const infoDisabled = infoMode === 'auto' && autoCapability?.optedIn !== true
  const visibleModes =
    modes ?? CLAUDE_MODE_ORDER.filter((m) => m !== 'auto' || autoCapability?.eligible === true)
  return (
    <DropdownMenu onOpenChange={(open) => !open && setInfoMode(null)}>
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
      <DropdownMenuContent align="end" className="flex w-auto p-0">
        <div className="w-64 p-1">
          {visibleModes.map((m) => {
            const itemMeta = MODE_META[m] ?? FALLBACK_META
            const ItemIcon = itemMeta.icon
            const selected = m === mode
            // `auto` is selectable only when eligible AND opted in. Eligible-but-not-opted-in
            // surfaces the option disabled with an opt-in hint instead of hiding it.
            const itemDisabled = m === 'auto' && autoCapability?.optedIn !== true
            // The row is disabled (no info pane), so the opt-in hint shows inline.
            const optInHint =
              m === 'auto' && autoCapability && !autoCapability.optedIn
                ? 'Run `claude` once and accept the auto-mode prompt to enable.'
                : null
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
                  'flex items-center gap-2 py-2',
                  selected && itemMeta.chip,
                  itemDisabled && 'opacity-50'
                )}
              >
                <ItemIcon className={cn('size-4 shrink-0', itemMeta.text)} />
                <div className="flex-1 min-w-0">
                  <div className={cn('text-xs font-medium', itemMeta.text)}>{itemMeta.label}</div>
                  {optInHint && (
                    <div className="text-[11px] text-muted-foreground leading-snug">
                      {optInHint}
                    </div>
                  )}
                </div>
                {m === defaultMode && <PickerDefaultTag />}
                <PickerInfoButton
                  label={itemMeta.label}
                  active={infoMode === m}
                  onToggle={() => setInfoMode(infoMode === m ? null : m)}
                />
              </DropdownMenuItem>
            )
          })}
        </div>
        {infoMode && infoMeta && (
          <PickerInfoPane
            className={infoMeta.text}
            title={
              <>
                <infoMeta.icon className="size-4 shrink-0" />
                {infoMeta.label}
              </>
            }
            details={infoMeta.details}
            isDefault={infoMode === defaultMode}
            onSetDefault={onSetDefault && (() => onSetDefault(infoMode))}
            setDisabled={infoDisabled}
          >
            <AgentModeIllustration mode={infoMode} className="h-16 w-full" />
          </PickerInfoPane>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
