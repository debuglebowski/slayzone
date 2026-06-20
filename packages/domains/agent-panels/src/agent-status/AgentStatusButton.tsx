import { Bell } from 'lucide-react'
import { cn, Tooltip, TooltipTrigger, TooltipContent, withShortcut } from '@slayzone/ui'

interface AgentStatusButtonProps {
  active: boolean
  count: number
  onClick: () => void
  shortcutHint?: string | null
  size?: 'sm' | 'lg'
}

export function AgentStatusButton({
  active,
  count,
  onClick,
  shortcutHint,
  size = 'sm'
}: AgentStatusButtonProps) {
  const btnSize = size === 'lg' ? 'size-10 rounded-lg' : 'h-7 w-7'
  const iconSize = size === 'lg' ? 'size-5' : 'size-4'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'relative flex items-center justify-center transition-colors border-b-2',
            btnSize,
            active
              ? 'text-foreground border-foreground'
              : 'text-muted-foreground border-transparent hover:text-foreground'
          )}
        >
          <Bell className={iconSize} />
          {count > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-foreground text-background text-[10px] font-medium leading-none">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {withShortcut(
          active ? 'Hide agent status panel' : 'Show agent status panel',
          shortcutHint ?? null
        )}
      </TooltipContent>
    </Tooltip>
  )
}
