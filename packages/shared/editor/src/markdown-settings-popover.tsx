import type { ReactNode } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@slayzone/ui'

interface MarkdownSettingsPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
}

export function MarkdownSettingsPopover({ open, onOpenChange, trigger, children }: MarkdownSettingsPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="end">
        <div className="space-y-8">{children}</div>
      </PopoverContent>
    </Popover>
  )
}
