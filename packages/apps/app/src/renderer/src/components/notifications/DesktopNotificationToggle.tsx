import { Podcast } from 'lucide-react'
import { cn, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'

interface DesktopNotificationToggleProps {
  enabled: boolean
  onToggle: () => void
}

export function DesktopNotificationToggle({ enabled, onToggle }: DesktopNotificationToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label="Toggle desktop notifications"
          onClick={onToggle}
          className={cn(
            'h-7 w-7 rounded-lg flex items-center justify-center transition-colors border-b-2',
            enabled
              ? 'text-foreground border-foreground'
              : 'text-muted-foreground border-transparent hover:text-foreground'
          )}
        >
          <Podcast className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {enabled ? 'Desktop notifications on' : 'Desktop notifications off'}
      </TooltipContent>
    </Tooltip>
  )
}
