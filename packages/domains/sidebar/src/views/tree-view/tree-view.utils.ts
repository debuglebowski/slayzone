import type { DragEndEvent, DragMoveEvent } from '@dnd-kit/core'
import type { Task } from '@slayzone/task/shared'
import { NONE_GROUP_KEY, PINNED_GROUP_KEY } from '../treeGrouping'
import { pointerYFromEvent, resolveDropMode } from '../projectDrop'
import type { ProjDropMode } from './tree-view.types'

// Project rows don't shift during a project drag (Discord behavior) — the
// dragged row stays as a static placeholder; the drop spot shows as an
// insertion line / merge ring instead. Returning null disables the sort
// transform for the project-level context (task rows keep their own strategy).
export const noShiftStrategy = () => null

/**
 * Drop mode over a project row, shared by the move-indicator and the drop. Uses
 * the same `resolveDropMode` as the rail view (single source of truth): folder
 * MEMBERS split in HALF (before/after — the whole row reorders, incl. the
 * group's bottom), top-level rows use the 3-zone split (middle = merge = new
 * folder / join), and a dragged folder never merges. Tree members are tagged
 * `kind:'project'` with a non-null `groupId`.
 */
export function treeProjectDropMode(event: DragMoveEvent | DragEndEvent): ProjDropMode {
  const over = event.over
  if (!over) return 'merge'
  const od = over.data.current as { kind?: string; groupId?: string | null } | undefined
  const aKind = (event.active.data.current as { kind?: string } | undefined)?.kind
  return resolveDropMode({
    pointerY: pointerYFromEvent(event),
    rect: over.rect,
    overIsMember: od?.kind === 'project' && od.groupId != null,
    activeIsGroup: aKind === 'group'
  })
}

export function rowGroupValue(
  task: Task,
  groupBy: 'none' | 'status' | 'priority',
  groupPinned: boolean,
  pinnedSet: Set<string>
): string {
  if (groupPinned && pinnedSet.has(task.id)) return PINNED_GROUP_KEY
  if (groupBy === 'none') return NONE_GROUP_KEY
  if (groupBy === 'priority') return `p${typeof task.priority === 'number' ? task.priority : 5}`
  return task.status
}
