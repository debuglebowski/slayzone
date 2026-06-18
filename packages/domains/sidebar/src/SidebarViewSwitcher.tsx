import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  cn,
  useShortcutDisplay
} from '@slayzone/ui'
import { Check, PanelLeftClose } from 'lucide-react'
import { viewRegistry, getView } from './views/registry'

interface SidebarViewSwitcherProps {
  current: string
  onChange: (id: string) => void
  compact?: boolean
  autoHide?: boolean
  onToggleAutoHide?: () => void
}

export function SidebarViewSwitcher({
  current,
  onChange,
  compact,
  autoHide,
  onToggleAutoHide
}: SidebarViewSwitcherProps) {
  const view = getView(current)
  const Icon = view.icon
  const autoHideShortcut = useShortcutDisplay('sidebar-auto-hide', 'verbose')

  const switcherTrigger = (
    <button
      type="button"
      aria-label={`Sidebar view: ${view.label}`}
      title={view.label}
      className={cn(
        'inline-flex items-center justify-center rounded-lg text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        compact ? 'h-10 w-10' : 'h-8 w-8'
      )}
    >
      <Icon className={compact ? 'size-5' : 'size-4'} />
    </button>
  )

  return (
    <DropdownMenu>
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{switcherTrigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{view.label}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{switcherTrigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent side="top" align="start" className="min-w-[200px]">
        {viewRegistry.map((v) => {
          const VIcon = v.icon
          const selected = v.id === current
          return (
            <DropdownMenuItem key={v.id} onSelect={() => onChange(v.id)} className="cursor-pointer">
              <VIcon className="size-4" />
              <span>{v.label}</span>
              {selected && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            onToggleAutoHide?.()
          }}
          className="cursor-pointer"
        >
          <PanelLeftClose className="size-4" />
          <span>Auto-hide</span>
          {autoHide && <Check className="size-4 col-start-3" />}
          {autoHideShortcut && (
            <kbd className="col-start-4 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
              {autoHideShortcut}
            </kbd>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
