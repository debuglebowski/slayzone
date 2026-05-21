import { ChevronDown, Sparkles } from 'lucide-react'
import { cn } from './utils'
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

export interface AgentModelPillProps {
  model: AgentModel
  onChange: (next: AgentModel) => void
  /**
   * Provider-specific model list. Defaults to the Claude set so existing
   * claude-chat callers need no change; codex-chat passes its own catalog.
   */
  models?: AgentModelOption[]
  disabled?: boolean
  /** Visual style. `pill` = chip (default). `text` = plain inline text. */
  variant?: 'pill' | 'text'
  className?: string
}

export function AgentModelPill({
  model,
  onChange,
  models,
  disabled,
  variant = 'pill',
  className
}: AgentModelPillProps) {
  const list = models && models.length > 0 ? models : DEFAULT_MODELS
  const meta = list.find((m) => m.id === model) ?? { id: model, label: model, description: '' }
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
        aria-label={`Chat model: ${meta.label}`}
      >
        <Sparkles className="size-3" />
        <span>{meta.label}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {list.map((m) => {
          const selected = m.id === model
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
              className={cn('flex items-start gap-2 py-2', selected && 'bg-accent/40')}
            >
              <Sparkles className="size-4 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{m.label}</div>
                {m.description ? (
                  <div className="text-[11px] text-muted-foreground leading-snug">
                    {m.description}
                  </div>
                ) : null}
              </div>
              {selected && (
                <span className="self-center rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  current
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
