import { Bot } from 'lucide-react'
import { cn, Tooltip, TooltipTrigger, TooltipContent, withShortcut } from '@slayzone/ui'

interface AgentPanelButtonProps {
  active: boolean
  disabled?: boolean
  onClick: () => void
  shortcutHint?: string | null
  size?: 'sm' | 'lg'
}

export function AgentPanelButton({ active, disabled, onClick, shortcutHint, size = 'sm' }: AgentPanelButtonProps) {
  const btnSize = size === 'lg' ? 'size-10 rounded-lg' : 'h-7 w-7'
  const iconSize = size === 'lg' ? 'size-5' : 'size-4'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          disabled={disabled}
          className={cn(
            btnSize,
            'flex items-center justify-center transition-colors border-b-2',
            disabled
              ? 'text-muted-foreground/40 cursor-not-allowed border-transparent'
              : active
                ? 'text-foreground border-foreground'
                : 'text-muted-foreground border-transparent hover:text-foreground'
          )}
        >
          <Bot className={iconSize} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {disabled ? 'Select a project first' : withShortcut(active ? 'Hide agent panel' : 'Show agent panel', shortcutHint ?? null)}
      </TooltipContent>
    </Tooltip>
  )
}
