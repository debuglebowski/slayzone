import { LayoutDashboard } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { OPEN_MANAGE_LAYOUTS_EVENT, parseTaskLayoutsSetting } from '@slayzone/task-contracts'
import { Button } from '@slayzone/ui'
import { useTRPC } from '../../trpc'

/**
 * Settings → Panels' way to the task layouts (docs/plans/panel-model.md step 11).
 * The order below builds the Classic layout — until the user edits Classic itself,
 * which then says so here. Manage layouts lives in the task domain; it opens on
 * `OPEN_MANAGE_LAYOUTS_EVENT` (the app shell mounts it).
 */
export function TaskLayoutsLink(): React.JSX.Element {
  const trpc = useTRPC()
  // staleTime 0: a layout saved in a task moments ago must show here on open.
  const { data } = useQuery(
    trpc.settings.get.queryOptions({ key: 'task_layouts' }, { staleTime: 0 })
  )
  const classicCustomized = !!parseTaskLayoutsSetting(data ?? null).builtinOverrides.classic
    ?.columns
  return (
    <div
      data-testid="panels-task-layouts"
      className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
    >
      <LayoutDashboard className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 text-sm">
        {classicCustomized ? (
          <span data-testid="panels-classic-customized">
            Classic is customized — edit it in Layouts. The order below no longer changes it.
          </span>
        ) : (
          <span className="text-muted-foreground">
            The order below is the Classic task layout. Other layouts are in Layouts.
          </span>
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        data-testid="panels-manage-layouts"
        onClick={() => window.dispatchEvent(new CustomEvent(OPEN_MANAGE_LAYOUTS_EVENT))}
      >
        Manage layouts…
      </Button>
    </div>
  )
}
