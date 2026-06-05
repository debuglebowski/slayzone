import { ChevronDown } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn
} from '@slayzone/ui'
import type { DeviceSlot, GridLayout, MultiDeviceConfig } from '../shared'
import { SLOT_BUTTONS } from './BrowserPanel.constants'

interface BrowserMultiDeviceToolbarProps {
  multiDeviceConfig: MultiDeviceConfig
  multiDeviceLayout: GridLayout
  onToggleSlot: (slot: DeviceSlot) => void
  onSetLayout: (layout: GridLayout) => void
}

export function BrowserMultiDeviceToolbar({
  multiDeviceConfig,
  multiDeviceLayout,
  onToggleSlot,
  onSetLayout
}: BrowserMultiDeviceToolbarProps) {
  return (
    <div className="shrink-0 flex items-center py-2 px-2 gap-3 border-b border-border bg-surface-0">
      {/* Device toggle buttons */}
      {SLOT_BUTTONS.map(({ slot, icon: Icon, label }) => {
        const enabled = multiDeviceConfig[slot].enabled
        return (
          <button
            key={slot}
            onClick={() => onToggleSlot(slot)}
            className={cn(
              'h-8 px-3 flex items-center gap-1.5 text-xs font-medium rounded-lg border transition-colors',
              enabled
                ? 'text-blue-400 bg-blue-500/15 border-blue-500/30 hover:bg-blue-500/25'
                : 'text-muted-foreground border-border hover:text-foreground hover:bg-surface-2'
            )}
          >
            <Icon className="size-3.5" />
            <span>{label}</span>
          </button>
        )
      })}
      <div className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
          >
            {multiDeviceLayout === 'horizontal' ? 'Side by side' : 'Stacked'}
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => onSetLayout('horizontal')}
            className={cn(multiDeviceLayout === 'horizontal' && 'text-blue-500 font-medium')}
          >
            Side by side
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onSetLayout('vertical')}
            className={cn(multiDeviceLayout === 'vertical' && 'text-blue-500 font-medium')}
          >
            Stacked
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
