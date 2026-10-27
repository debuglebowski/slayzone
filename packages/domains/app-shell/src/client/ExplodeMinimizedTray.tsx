import { ChevronDown, Minimize2 } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@slayzone/ui'

export interface ExplodeMinimizedTrayProps {
  /** Minimized task ids, in the user's arranged order. */
  taskIds: readonly string[]
  titleFor: (taskId: string) => string
  onRestore: (taskId: string) => void
  onRestoreAll: () => void
}

/**
 * Header parking bay for explode-mode terminals the user minimized.
 *
 * Lives beside the "N tasks" label because explode mode is the one tab layout
 * with spare header room. A minimized terminal is NOT closed or unmounted — it
 * keeps running with its scrollback intact and simply stops being given grid
 * space, so the remaining cells repack over it. Picking one here puts it straight
 * back into the mix.
 *
 * Renders nothing when the bay is empty (the caller gates on length, and this
 * guards again) so explode mode looks untouched until the feature is used.
 */
export function ExplodeMinimizedTray({
  taskIds,
  titleFor,
  onRestore,
  onRestoreAll
}: ExplodeMinimizedTrayProps): React.JSX.Element | null {
  if (taskIds.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="ml-2 h-6 gap-1 px-2 text-xs text-muted-foreground flex-shrink-0"
          aria-label={`${taskIds.length} minimized ${taskIds.length === 1 ? 'terminal' : 'terminals'}`}
          data-testid="explode-minimized-tray"
        >
          <Minimize2 className="size-3" />
          {taskIds.length}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {taskIds.map((taskId) => (
          <DropdownMenuItem
            key={taskId}
            onSelect={() => onRestore(taskId)}
            className="text-xs"
            data-testid="explode-restore-item"
          >
            <span className="truncate">{titleFor(taskId)}</span>
          </DropdownMenuItem>
        ))}
        {taskIds.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRestoreAll} className="text-xs font-medium">
              Restore all
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
