import { Check, LayoutDashboard } from 'lucide-react'
import type { BuiltinLayoutSpec, LayoutCapabilities, TaskLayout } from '@slayzone/task-contracts'
import {
  BUILTIN_LAYOUTS,
  isBuiltinLayoutAvailable,
  isClassicShaped
} from '@slayzone/task-contracts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { HEADER_BUTTON_CLASS } from './headerButton'

/**
 * The layout a task shows, by name: "Classic" while it is Classic-shaped (follows
 * panel_config), else "Custom" (the user moved, split or added panels).
 */
export function currentLayoutName(layout: TaskLayout): string {
  if (isClassicShaped(layout)) return 'Classic'
  // TODO(panel-model step 10): a layout applied from a definition and unchanged
  // since is called by that definition's name.
  return 'Custom'
}

/** Built-in layouts this app can show, in display order. */
export function availableBuiltinLayouts(caps: LayoutCapabilities): BuiltinLayoutSpec[] {
  return BUILTIN_LAYOUTS.filter((spec) => isBuiltinLayoutAvailable(spec, caps))
}

/**
 * The title row's Layout button: the current layout's name and the built-in
 * layouts. Without `onSelectLayout` the list is shown but not selectable.
 */
export function LayoutMenu({
  layout,
  capabilities,
  onSelectLayout,
  align = 'end'
}: {
  layout: TaskLayout
  capabilities: LayoutCapabilities
  /** TODO(panel-model step 10): switch layouts (parking leftover instances as hidden tabs). */
  onSelectLayout?: (layoutId: string) => void
  align?: 'start' | 'end'
}): React.JSX.Element {
  const name = currentLayoutName(layout)
  const builtins = availableBuiltinLayouts(capabilities)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Layout"
              data-testid="layout-menu"
              className={HEADER_BUTTON_CLASS}
            >
              <LayoutDashboard className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Layout: {name}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align={align}
        data-testid="layout-menu-content"
        className="w-max min-w-52 max-w-80"
      >
        <DropdownMenuLabel className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Layout</span>
          <span data-testid="layout-menu-current" className="truncate">
            {name}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {builtins.map((spec) => {
          const current = spec.id === layout.layoutId && name !== 'Custom'
          return (
            <DropdownMenuItem
              key={spec.id}
              disabled={!onSelectLayout}
              className="gap-2"
              onSelect={() => onSelectLayout?.(spec.id)}
            >
              <Check className={current ? 'size-4' : 'size-4 invisible'} />
              <span className="flex-1 truncate">{spec.name}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
