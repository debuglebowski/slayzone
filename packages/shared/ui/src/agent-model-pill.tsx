import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from './utils'
import { PickerDefaultTag, PickerInfoButton, PickerInfoPane } from './picker-info'
import { AgentModelIllustration } from './agent-picker-illustrations'
import { modelLook } from './picker-tones'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './dropdown-menu'

/** An opaque, provider-specific model id (Claude alias / Codex model id). */
export type AgentModel = string

export interface AgentModelOption {
  id: string
  label: string
  description?: string
}

/**
 * Default model list (Claude). Used when the caller doesn't pass a
 * provider-specific `models` list — keeps existing claude-chat call sites
 * working unchanged.
 */
const DEFAULT_MODELS: AgentModelOption[] = [
  { id: 'opus', label: 'Opus', description: 'Maximum capability. Slower, higher cost.' },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Balanced speed + capability. Recommended for most chats.'
  },
  { id: 'haiku', label: 'Haiku', description: 'Fastest + cheapest. Best for simple tasks.' }
]

/**
 * Info-pane text for Claude's aliases — the served Claude list carries no
 * descriptions; other providers' models use their own `description`.
 */
const MODEL_DETAILS: Record<string, string> = {
  opus: 'The most capable Claude model. Best for complex, multi-step coding and reasoning. Slower, and uses more of your usage limits.',
  sonnet: 'Balanced speed and capability. A strong choice for most everyday coding.',
  haiku:
    'The fastest and cheapest Claude model. Good for quick, simple tasks. Has no reasoning-effort setting.'
}

/** A model's info-pane text: Claude's alias text, else its own description. */
function modelDetails(m: AgentModelOption): string {
  return MODEL_DETAILS[m.id] ?? m.description ?? 'No description from the provider.'
}

export interface AgentModelPillProps {
  model: AgentModel
  onChange: (next: AgentModel) => void
  /**
   * Provider-specific model list. Defaults to the Claude set so existing
   * claude-chat callers need no change; codex-chat passes its own catalog.
   */
  models?: AgentModelOption[]
  /**
   * The provider listed no models yet (`models` given and empty): the pill
   * reads `emptyLabel` (e.g. "Default") and the menu shows `emptyHint`.
   * Without it, an empty list falls back to the Claude set.
   */
  emptyLabel?: string
  emptyHint?: string
  disabled?: boolean
  /** Visual style. `pill` = chip (default). `text` = plain inline text. */
  variant?: 'pill' | 'text'
  className?: string
  /** The user's default model; its row is tagged "default". */
  defaultModel?: AgentModel
  /** When set, the info pane offers "Set as default" for the model it explains. */
  onSetDefault?: (model: AgentModel) => void
}

export function AgentModelPill({
  model,
  onChange,
  models,
  emptyLabel,
  emptyHint,
  disabled,
  variant = 'pill',
  className,
  defaultModel,
  onSetDefault
}: AgentModelPillProps) {
  const unlisted = emptyLabel !== undefined && models !== undefined && models.length === 0
  const list = unlisted ? [] : models && models.length > 0 ? models : DEFAULT_MODELS
  const meta = list.find((m) => m.id === model) ?? {
    id: model,
    label: unlisted || !model ? (emptyLabel ?? model) : model,
    description: ''
  }
  // Model whose info pane is open (the popup grows a second column), or null.
  const [infoId, setInfoId] = useState<string | null>(null)
  const info = infoId ? list.find((m) => m.id === infoId) : undefined
  const look = modelLook(
    model,
    list.findIndex((m) => m.id === model)
  )
  const infoLook = info ? modelLook(info.id, list.indexOf(info)) : null
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
        aria-label={`Chat model: ${meta.label}`}
      >
        <look.icon className="size-3" />
        <span>{meta.label}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="flex w-auto p-0">
        <div className="w-56 p-1">
          {unlisted && emptyHint && (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{emptyHint}</div>
          )}
          {list.map((m, i) => {
            const selected = m.id === model
            const rowLook = modelLook(m.id, i)
            return (
              <DropdownMenuItem
                key={m.id}
                onSelect={(e) => {
                  if (m.id === model) {
                    e.preventDefault()
                    return
                  }
                  onChange(m.id)
                }}
                className={cn('flex items-center gap-2 py-2', selected && rowLook.tone.chip)}
              >
                <rowLook.icon className={cn('size-3.5 shrink-0', rowLook.tone.text)} />
                <span
                  className={cn('flex-1 min-w-0 truncate text-xs', selected && 'font-semibold')}
                >
                  {m.label}
                </span>
                {m.id === defaultModel && <PickerDefaultTag />}
                <PickerInfoButton
                  label={m.label}
                  active={infoId === m.id}
                  onToggle={() => setInfoId(infoId === m.id ? null : m.id)}
                />
              </DropdownMenuItem>
            )
          })}
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
            details={modelDetails(info)}
            isDefault={info.id === defaultModel}
            onSetDefault={onSetDefault && (() => onSetDefault(info.id))}
          >
            <AgentModelIllustration model={info.id} className="h-16 w-full" />
          </PickerInfoPane>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
