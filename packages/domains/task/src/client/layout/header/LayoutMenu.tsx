import { useState } from 'react'
import { LayoutDashboard, Settings2 } from 'lucide-react'
import type { ResolvedLayoutDefinition } from '@slayzone/task-contracts'
import { shortcutPositionOf } from '@slayzone/task-contracts'
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  formatKeysForDisplay,
  resolveShortcutKeys,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useShortcutStore
} from '@slayzone/ui'
import { LayoutThumb } from '../../layouts/LayoutThumb'
import { HEADER_BUTTON_CLASS } from './headerButton'

/** The name the Layout button shows: the applied definition's, else "Custom". */
export function currentLayoutName(current: ResolvedLayoutDefinition | null): string {
  return current?.name ?? 'Custom'
}

export interface LayoutMenuProps {
  /** Every layout, in display order; the menu lists the enabled ones. */
  layouts: readonly ResolvedLayoutDefinition[]
  /** The definition the task's layout was applied from (null: deleted or unknown). */
  current: ResolvedLayoutDefinition | null
  /** The task's layout differs from `current` (or has none): "Unsaved changes". */
  dirty: boolean
  onSelectLayout: (layoutId: string) => void
  /** Re-apply `current`. */
  onRevert: () => void
  /** Store the task's layout as `current`. */
  onSave: () => void
  /** Store the task's layout as a new layout. */
  onSaveAs: () => void
  onManage: () => void
  align?: 'start' | 'end'
}

/**
 * The title row's Layout button (docs/plans/panel-model.md step 10): the enabled
 * layouts (thumbnail, name, "· edited" for a changed built-in, ⌃⌥N), the current one
 * checked; an "Unsaved changes" header with Revert / Save as… / Save while the task's
 * layout differs from its definition; Manage layouts… at the bottom.
 */
export function LayoutMenu({
  layouts,
  current,
  dirty,
  onSelectLayout,
  onRevert,
  onSave,
  onSaveAs,
  onManage,
  align = 'end'
}: LayoutMenuProps): React.JSX.Element {
  const overrides = useShortcutStore((s) => s.overrides)
  const [open, setOpen] = useState(false)
  /** The header's buttons are not menu items: close the menu ourselves, then act. */
  const closeThen = (action: () => void) => () => {
    setOpen(false)
    action()
  }
  const name = currentLayoutName(current)
  const enabled = layouts.filter((l) => l.enabled)
  const shortcutOf = (id: string): string | null => {
    const n = shortcutPositionOf(layouts, id)
    if (n === null) return null
    const keys = resolveShortcutKeys(overrides, `switch-layout-${n}`)
    return keys ? formatKeysForDisplay(keys) : null
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Layout"
              data-testid="layout-menu"
              data-layout-dirty={dirty ? 'true' : undefined}
              className={cn(HEADER_BUTTON_CLASS, 'relative')}
            >
              <LayoutDashboard className="size-4" />
              {dirty && (
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-warning"
                />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Layout: {name}
          {dirty ? ' (changed)' : ''}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align={align}
        data-testid="layout-menu-content"
        className="w-max min-w-60 max-w-80"
      >
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
          <span className="text-xs text-muted-foreground">Layout</span>
          <span data-testid="layout-menu-current" className="truncate font-medium">
            {name}
          </span>
        </div>
        {dirty && (
          <div
            data-testid="layout-unsaved"
            className="mx-1 mb-1 flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1.5"
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
            <span className="flex-1 text-xs">Unsaved changes</span>
            {current && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                data-testid="layout-revert"
                title={`Go back to “${current.name}”`}
                onClick={closeThen(onRevert)}
              >
                Revert
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              data-testid="layout-save-as"
              onClick={closeThen(onSaveAs)}
            >
              Save as…
            </Button>
            {current && (
              <Button
                size="sm"
                className="h-6 px-2 text-xs"
                data-testid="layout-save"
                title={`Update “${current.name}”`}
                onClick={closeThen(onSave)}
              >
                Save
              </Button>
            )}
          </div>
        )}
        <DropdownMenuSeparator />
        {enabled.map((def) => {
          const isCurrent = def.id === current?.id
          const shortcut = shortcutOf(def.id)
          return (
            <DropdownMenuItem
              key={def.id}
              data-testid={`layout-option-${def.id}`}
              data-current={isCurrent ? 'true' : undefined}
              className={cn('gap-2.5', isCurrent && 'bg-accent/50')}
              onSelect={() => onSelectLayout(def.id)}
            >
              <LayoutThumb tree={def} active={isCurrent} />
              <span className="flex-1 truncate">
                {def.name}
                {def.edited && <span className="text-muted-foreground"> · edited</span>}
                {isCurrent && dirty && <span className="text-warning"> •</span>}
              </span>
              {shortcut && (
                <span className="ml-4 text-[10px] text-muted-foreground tabular-nums">
                  {shortcut}
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5" data-testid="layout-manage" onSelect={onManage}>
          <Settings2 className="size-4" />
          Manage layouts…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
