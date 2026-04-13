import { Bell } from 'lucide-react'
import { cn, Tooltip, TooltipTrigger, TooltipContent, withShortcut } from '@slayzone/ui'

interface NotificationButtonProps {
  active: boolean
  count: number
  onClick: () => void
  shortcutHint?: string | null
}

export function NotificationButton({ active, count, onClick, shortcutHint }: NotificationButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'relative h-7 w-7 flex items-center justify-center transition-colors border-b-2',
            active
              ? 'text-foreground border-foreground'
              : 'text-muted-foreground border-transparent hover:text-foreground'
          )}
        >
          <Bell className="size-4" />
          {count > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-foreground text-background text-[10px] font-medium leading-none">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {withShortcut(active ? 'Hide notifications panel' : 'Show notifications panel', shortcutHint ?? null)}
      </TooltipContent>
    </Tooltip>
  )
}
