import { ChevronDown, ClipboardList, Hammer } from 'lucide-react'
import { cn } from './utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './dropdown-menu'

export type AgentCollaborationMode = 'default' | 'plan'

interface CollaborationMeta {
  label: string
  short: string
  description: string
  Icon: typeof Hammer
}

const COLLABORATION_META: Record<AgentCollaborationMode, CollaborationMeta> = {
  default: {
    label: 'Build',
    short: 'Build',
    description: 'Normal mode — the agent edits files and runs commands.',
    Icon: Hammer
  },
  plan: {
    label: 'Plan',
    short: 'Plan',
    description: 'Read-only — the agent investigates and drafts a plan instead of editing.',
    Icon: ClipboardList
  }
}

const COLLABORATION_ORDER: AgentCollaborationMode[] = ['default', 'plan']

export interface AgentCollaborationPillProps {
  collaboration: AgentCollaborationMode
  onChange: (next: AgentCollaborationMode) => void
  disabled?: boolean
  compact?: boolean
  /** Visual style. `pill` = chip (default). `text` = plain inline text. */
  variant?: 'pill' | 'text'
  className?: string
}

/**
 * Composer dropdown for the chat collaboration mode (Codex `plan`/`default`) —
 * the behavioral axis, orthogonal to the permission-mode and effort pills.
 */
export function AgentCollaborationPill({
  collaboration,
  onChange,
  disabled,
  compact,
  variant = 'pill',
  className
}: AgentCollaborationPillProps) {
  const meta = COLLABORATION_META[collaboration]
  const { Icon } = meta
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'inline-flex items-center transition-colors',
          variant === 'pill'
            ? 'gap-1.5 rounded-full ring-1 px-2 py-0.5 text-2xs font-medium bg-muted/40 text-muted-foreground ring-border hover:bg-muted/60 hover:text-foreground'
            : 'gap-1 rounded px-1 py-0.5 text-3xs text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
        title={meta.description}
        aria-label={`Collaboration mode: ${meta.label}`}
      >
        <Icon className="size-3" />
        <span>{compact ? meta.short : meta.label}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {COLLABORATION_ORDER.map((id) => {
          const itemMeta = COLLABORATION_META[id]
          const ItemIcon = itemMeta.Icon
          const selected = id === collaboration
          return (
            <DropdownMenuItem
              key={id}
              onSelect={(e) => {
                if (id === collaboration) {
                  e.preventDefault()
                  return
                }
                onChange(id)
              }}
              className={cn('flex items-start gap-2 py-2', selected && 'bg-accent/40')}
            >
              <ItemIcon className="size-4 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{itemMeta.label}</div>
                <div className="text-2xs text-muted-foreground leading-snug">
                  {itemMeta.description}
                </div>
              </div>
              {selected && (
                <span className="text-3xs text-muted-foreground self-center">current</span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
