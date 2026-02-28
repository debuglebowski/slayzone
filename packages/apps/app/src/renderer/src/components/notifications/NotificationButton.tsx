import { Bell } from 'lucide-react'
import { cn, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'

interface NotificationButtonProps {
  active: boolean
  count: number
  onClick: () => void
}

export function NotificationButton({ active, count, onClick }: NotificationButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label="Notifications"
          onClick={onClick}
          className={cn(
            'h-7 w-7 rounded-lg flex items-center justify-center transition-colors border-b-2',
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
        {active ? 'Hide notifications panel' : 'Show notifications panel'}
      </TooltipContent>
    </Tooltip>
  )
}
