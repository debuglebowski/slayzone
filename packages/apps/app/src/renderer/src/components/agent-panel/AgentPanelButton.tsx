import { Bot } from 'lucide-react'
import { cn, Tooltip, TooltipTrigger, TooltipContent, withShortcut } from '@slayzone/ui'

interface AgentPanelButtonProps {
  active: boolean
  disabled?: boolean
  onClick: () => void
  shortcutHint?: string | null
}

export function AgentPanelButton({ active, disabled, onClick, shortcutHint }: AgentPanelButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'h-7 w-7 flex items-center justify-center transition-colors border-b-2',
            disabled
              ? 'text-muted-foreground/40 cursor-not-allowed border-transparent'
              : active
                ? 'text-foreground border-foreground'
                : 'text-muted-foreground border-transparent hover:text-foreground'
          )}
        >
          <Bot className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {disabled ? 'Select a project first' : withShortcut(active ? 'Hide agent panel' : 'Show agent panel', shortcutHint ?? null)}
      </TooltipContent>
    </Tooltip>
  )
}
