import type { LucideIcon } from 'lucide-react'

import { cn } from './utils'
import { Tooltip, TooltipTrigger, TooltipContent } from './tooltip'

interface PanelToggleItem {
  id: string
  icon: LucideIcon
  label: string
  active: boolean
  shortcut?: string
  disabled?: boolean
}

interface PanelToggleProps {
  panels: PanelToggleItem[]
  onChange: (id: string, active: boolean) => void
  variant?: 'raised' | 'flat'
  className?: string
}

const variantStyles = {
  raised: {
    container: 'bg-muted',
    active: 'bg-muted-foreground/20 text-foreground shadow-sm',
    activeDisabled: 'bg-muted-foreground/20 text-foreground/40 shadow-sm cursor-not-allowed',
  },
  flat: {
    container: 'bg-muted/50',
    active: 'bg-muted text-foreground shadow-sm',
    activeDisabled: 'bg-muted text-foreground/40 shadow-sm cursor-not-allowed',
  },
}

export function PanelToggle({ panels, onChange, variant = 'flat', className }: PanelToggleProps) {
  const styles = variantStyles[variant]
  return (
    <div className={cn('flex items-center rounded-lg p-1 gap-1', styles.container, className)}>
      {panels.map((panel) => (
        <Tooltip key={panel.id}>
          <TooltipTrigger asChild>
            <button
              onClick={() => onChange(panel.id, !panel.active)}
              disabled={panel.disabled}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                panel.disabled
                  ? panel.active
                    ? styles.activeDisabled
                    : 'text-muted-foreground/40 cursor-not-allowed'
                  : panel.active
                    ? styles.active
                    : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <panel.icon className="size-3.5" />
              {panel.label}
              {panel.shortcut && (
                <span className={cn(
                  'ml-1 text-[10px]',
                  panel.active ? 'text-muted-foreground' : 'text-muted-foreground/60'
                )}>
                  {panel.shortcut}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {panel.disabled
              ? `Select a project to use ${panel.label}`
              : `${panel.active ? 'Hide' : 'Show'} ${panel.label} panel${panel.shortcut ? ` (${panel.shortcut})` : ''}`}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
