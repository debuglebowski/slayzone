import type { TopLevelEntryRef } from '@slayzone/projects/shared'

/**
 * Shared project drag-and-drop decision logic for BOTH sidebar views (Discord
 * rail folders + tree labels). The two views differ only in geometry (40px
 * tiles vs full-width rows) — they each compute a normalized `DropInput` and
 * call `resolveProjectDrop`, so the membership/reorder semantics live in ONE
 * tested place instead of duplicated branch trees. `applyProjectDrop` dispatches
 * the resulting action to the data handlers.
 */

export type DropMode = 'before' | 'after' | 'merge'

/**
 * The cursor's Y during a drag = where the drag STARTED + how far it moved.
 * dnd-kit gives `activatorEvent` (pointer-down) + cumulative `delta`. Using the
 * pointer (not the dragged element's rect center) is essential: a dragged row
 * can be tall, so its center skews the mode toward 'after' — the pointer is
 * where the user actually aims.
 */
export function pointerYFromEvent(event: {
  activatorEvent: Event | null
  delta: { y: number }
}): number | null {
  const a = event.activatorEvent as { clientY?: number } | null
  return a && typeof a.clientY === 'number' ? a.clientY + event.delta.y : null
}

/** Top third → before, bottom third → after, middle → merge. */
export function dropModeFromPointer(
  pointerY: number | null,
  rect: { top: number; height: number } | null | undefined
): DropMode {
  if (pointerY == null || !rect) return 'merge'
  if (pointerY < rect.top + rect.height / 3) return 'before'
  if (pointerY > rect.top + (rect.height * 2) / 3) return 'after'
  return 'merge'
}

export type DropAction =
  | { type: 'none' }
  /** Discord drag-onto → new folder of [target, dragged]. */
  | { type: 'createFolder'; projectIds: [string, string] }
  /** Move a project into a group at an index. */
  | { type: 'join'; groupId: string; projectId: string; index: number }
  /** Move a project out of its group to the top level at an index. */
  | { type: 'moveOut'; projectId: string; index: number }
  /** Reorder the members within a single group. */
  | { type: 'reorderWithin'; groupId: string; projectIds: string[] }
  /** Reorder the full top-level slot list (ungrouped projects + groups). */
  | { type: 'reorderTop'; refs: TopLevelEntryRef[] }

export interface DropInput {
  /** The dragged item. `isGroup` = a folder is being dragged (reorder only). */
  active: { id: string; group: string | null; isGroup?: boolean }
  /**
   * The drop target. `kind:'group'` = a folder/header (→ join). `kind:'project'`
   * with `group` set = a folder member; `group:null` = a top-level project.
   */
  over: { kind: 'project' | 'group'; id: string; group: string | null }
  /** Geometry hint from the view: top/bottom third → line, middle → merge. */
  mode: DropMode
  /** Full top-level slot order (ungrouped projects + groups). */
  topLevel: TopLevelEntryRef[]
  /** Full ordered member ids of a group. */
  members: (groupId: string) => string[]
}

/** Remove `activeRef`, then insert it before/after `overRef`. */
function insertRef(
  refs: TopLevelEntryRef[],
  activeRef: TopLevelEntryRef,
  overRef: TopLevelEntryRef,
  mode: DropMode
): TopLevelEntryRef[] {
  const list = refs.filter((r) => !(r.kind === activeRef.kind && r.id === activeRef.id))
  let t = list.findIndex((r) => r.kind === overRef.kind && r.id === overRef.id)
  if (t < 0) return refs
  if (mode === 'after') t += 1
  list.splice(t, 0, activeRef)
  return list
}

export function resolveProjectDrop(input: DropInput): DropAction {
  const { active, over, mode, topLevel, members } = input

  // ── Folder dragged → reorder among top-level slots only (never nests) ──────
  if (active.isGroup) {
    if (mode === 'merge') return { type: 'none' }
    if (over.kind === 'group' && over.id === active.id) return { type: 'none' }
    // Can't position relative to a folder member — only top-level slots.
    if (over.kind === 'project' && over.group !== null) return { type: 'none' }
    const overRef: TopLevelEntryRef =
      over.kind === 'group' ? { kind: 'group', id: over.id } : { kind: 'project', id: over.id }
    return { type: 'reorderTop', refs: insertRef(topLevel, { kind: 'group', id: active.id }, overRef, mode) }
  }

  // ── Project dragged onto a GROUP ───────────────────────────────────────────
  // middle (merge) → join the folder; top/bottom edge → reorder AROUND it at the
  // top level (so a project can land before/after a folder, incl. a last one).
  if (over.kind === 'group') {
    if (mode === 'merge') {
      if (active.group === over.id) return { type: 'none' }
      return { type: 'join', groupId: over.id, projectId: active.id, index: members(over.id).length }
    }
    if (active.group !== null) {
      // Member → top level, positioned around the folder (leaves its group).
      const i = topLevel.findIndex((r) => r.kind === 'group' && r.id === over.id)
      if (i < 0) return { type: 'none' }
      return { type: 'moveOut', projectId: active.id, index: Math.max(0, mode === 'after' ? i + 1 : i) }
    }
    return {
      type: 'reorderTop',
      refs: insertRef(topLevel, { kind: 'project', id: active.id }, { kind: 'group', id: over.id }, mode)
    }
  }

  // ── Project dragged onto another PROJECT ROW ───────────────────────────────
  if (over.id === active.id) return { type: 'none' }
  const tGroup = over.group

  if (tGroup !== null) {
    // Target is a folder member.
    const list = members(tGroup)
    if (mode === 'merge') {
      if (active.group === tGroup) return { type: 'none' }
      return { type: 'join', groupId: tGroup, projectId: active.id, index: Math.max(0, list.indexOf(over.id)) }
    }
    let idx = list.indexOf(over.id)
    if (mode === 'after') idx += 1
    if (active.group === tGroup) {
      const without = list.filter((id) => id !== active.id)
      const insertAt = Math.min(
        Math.max(0, idx - (list.indexOf(active.id) < idx ? 1 : 0)),
        without.length
      )
      without.splice(insertAt, 0, active.id)
      return { type: 'reorderWithin', groupId: tGroup, projectIds: without }
    }
    return { type: 'join', groupId: tGroup, projectId: active.id, index: Math.max(0, idx) }
  }

  // Target is a top-level project.
  if (mode === 'merge') return { type: 'createFolder', projectIds: [over.id, active.id] }
  if (active.group !== null) {
    // Member dropped on a top-level edge → leave its group (drag-out).
    const i = topLevel.findIndex((r) => r.kind === 'project' && r.id === over.id)
    return { type: 'moveOut', projectId: active.id, index: Math.max(0, mode === 'after' ? i + 1 : i) }
  }
  return {
    type: 'reorderTop',
    refs: insertRef(topLevel, { kind: 'project', id: active.id }, { kind: 'project', id: over.id }, mode)
  }
}

export interface ProjectDropHandlers {
  onCreateFolderWithProjects?: (projectIds: string[]) => void
  onMoveProjectToGroup?: (projectId: string, groupId: string | null, index: number) => void
  onReorderProjectsInGroup?: (groupId: string, projectIds: string[]) => void
  onReorderTopLevel?: (refs: TopLevelEntryRef[]) => void
}

export function applyProjectDrop(action: DropAction, h: ProjectDropHandlers): void {
  switch (action.type) {
    case 'createFolder':
      h.onCreateFolderWithProjects?.(action.projectIds)
      break
    case 'join':
      h.onMoveProjectToGroup?.(action.projectId, action.groupId, action.index)
      break
    case 'moveOut':
      h.onMoveProjectToGroup?.(action.projectId, null, action.index)
      break
    case 'reorderWithin':
      h.onReorderProjectsInGroup?.(action.groupId, action.projectIds)
      break
    case 'reorderTop':
      h.onReorderTopLevel?.(action.refs)
      break
    case 'none':
      break
  }
}
