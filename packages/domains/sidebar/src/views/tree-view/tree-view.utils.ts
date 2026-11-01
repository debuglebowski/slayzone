import {
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent
} from '@dnd-kit/core'
import type { Task } from '@slayzone/task-contracts'
import { NONE_GROUP_KEY, PINNED_GROUP_KEY } from '../treeGrouping'
import { pointerYFromEvent, resolveDropMode, type DropInput } from '../projectDrop'
import type { ProjectDragData, ProjectGroupDragData, ProjDropMode } from './tree-view.types'

// Folder/project targets and task/status targets live in different tree levels.
// A project's droppable covers its entire expanded block, so pointerWithin
// keeps drags over task contents attached to the containing project.
export const treeCollisionDetection: CollisionDetection = (args) => {
  const active = args.active.data.current
  const projectDrag = active?.kind === 'project' || active?.kind === 'project-group'
  const droppableContainers = args.droppableContainers.filter((container) => {
    const data = container.data.current
    if (projectDrag) return data?.kind === 'project' || data?.kind === 'project-group'
    return (data?.kind === 'task' || data?.kind === 'group') && data.projectId === active?.projectId
  })
  const scoped = { ...args, droppableContainers }
  if (projectDrag) {
    const within = pointerWithin(scoped)
    if (within.length > 0) return within
  }
  return closestCenter(scoped)
}

/** Normalize once for both the insertion preview and the committed action. */
export function treeProjectDropTarget(event: DragMoveEvent | DragEndEvent): {
  overId: string
  over: DropInput['over']
  mode: ProjDropMode
} | null {
  const { active, over } = event
  if (!over || active.id === over.id) return null
  const ad = active.data.current as ProjectDragData | ProjectGroupDragData | undefined
  const od = over.data.current as ProjectDragData | ProjectGroupDragData | undefined
  if (ad?.kind !== 'project' && ad?.kind !== 'project-group') return null
  if (od?.kind !== 'project' && od?.kind !== 'project-group') return null
  let target: DropInput['over'] =
    od.kind === 'project-group'
      ? { kind: 'group', id: od.groupId, group: null }
      : { kind: 'project', id: od.projectId, group: od.groupId }
  let overId = String(over.id)
  if (ad.kind === 'project-group' && od.kind === 'project' && od.groupId !== null) {
    target = { kind: 'group', id: od.groupId, group: null }
    overId = `group:${od.groupId}`
  }
  if (ad.kind === 'project-group' && target.kind === 'group' && target.id === ad.groupId)
    return null
  return { overId, over: target, mode: treeProjectDropMode(event) }
}

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
    activeIsGroup: aKind === 'project-group'
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
