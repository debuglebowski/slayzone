/**
 * The tree sidebar's display settings: what the project tree shows and how its rows
 * look. The live values sit on the tab store as flat `tree*` fields (every tree
 * component reads them there); a lens (`lenses.ts`) saves a copy of them.
 */

export type TreeGroupBy = 'none' | 'status' | 'priority'
export type TreeOrderBy =
  | 'manual'
  | 'priority'
  | 'due_date'
  | 'title'
  | 'created'
  | 'last_interaction'
export type TreeOrderDir = 'asc' | 'desc'

export interface TreeDisplay {
  // Task statuses to include.
  treeStatusFilter: string[]
  // Priorities to include. Empty = no priority constraint (all priorities pass).
  treePriorityFilter: number[]
  // Indicators on each task row.
  treeShowStatus: boolean
  treeShowPriority: boolean
  // Render sub-tasks at all (off → roots only).
  treeShowSubtasks: boolean
  // When sub-tasks shown, include every descendant of a matching root (off → only
  // descendants that themselves pass the filter).
  treeShowAllSubtasks: boolean
  // When sub-tasks shown, include every undone descendant of a matching root.
  // Ignored when `treeShowAllSubtasks` is on.
  treeShowAllUndoneSubtasks: boolean
  // Strikethrough completed (done) task rows.
  treeCrossOutDone: boolean
  // Show only tasks with an active PTY/chat session (or pinned).
  treeShowOnlyActive: boolean
  // Include temporary tasks.
  treeShowTemporary: boolean
  // Include tasks with the `is_blocked` flag set.
  treeShowBlocked: boolean
  // Include tasks whose `snoozed_until` is in the future.
  treeShowSnoozed: boolean
  // Always include tasks that have an open tab, regardless of filters.
  treeShowAllOpen: boolean
  // Worktree pill on tasks that have a worktree.
  treeShowWorktree: boolean
  treeShowTags: boolean
  // "Blocked" icon on tasks that are flagged blocked or have open blockers.
  treeShowBlockedBadge: boolean
  // Layout within each project — decoupled from the kanban filter.
  treeGroupBy: TreeGroupBy
  treeOrderBy: TreeOrderBy
  treeOrderDir: TreeOrderDir
  // Temporary tasks in their own "Temporary" group at the top (off: mixed in).
  treeGroupTemporary: boolean
  // Pinned tasks in their own "Pinned" group at the top (off: mixed in).
  treeGroupPinned: boolean
  // Blocked tasks in their own group, including dependency blockers.
  treeGroupBlocked: boolean
  // Group headers for groups with zero tasks (respecting treeStatusFilter).
  treeShowEmptyGroups: boolean
}

export const TREE_DISPLAY_KEYS = [
  'treeStatusFilter',
  'treePriorityFilter',
  'treeShowStatus',
  'treeShowPriority',
  'treeShowSubtasks',
  'treeShowAllSubtasks',
  'treeShowAllUndoneSubtasks',
  'treeCrossOutDone',
  'treeShowOnlyActive',
  'treeShowTemporary',
  'treeShowBlocked',
  'treeShowSnoozed',
  'treeShowAllOpen',
  'treeShowWorktree',
  'treeShowTags',
  'treeShowBlockedBadge',
  'treeGroupBy',
  'treeOrderBy',
  'treeOrderDir',
  'treeGroupTemporary',
  'treeGroupPinned',
  'treeGroupBlocked',
  'treeShowEmptyGroups'
] as const satisfies ReadonlyArray<keyof TreeDisplay>

export const DEFAULT_TREE_DISPLAY: TreeDisplay = {
  treeStatusFilter: ['in_progress'],
  treePriorityFilter: [1, 2, 3, 4, 5],
  treeShowStatus: false,
  treeShowPriority: true,
  treeShowSubtasks: true,
  treeShowAllSubtasks: false,
  treeShowAllUndoneSubtasks: false,
  treeCrossOutDone: false,
  treeShowOnlyActive: false,
  treeShowTemporary: true,
  treeShowBlocked: true,
  treeShowSnoozed: true,
  treeShowAllOpen: true,
  treeShowWorktree: true,
  treeShowTags: false,
  treeShowBlockedBadge: true,
  treeGroupBy: 'status',
  treeOrderBy: 'manual',
  treeOrderDir: 'asc',
  treeGroupTemporary: true,
  treeGroupPinned: true,
  treeGroupBlocked: false,
  treeShowEmptyGroups: false
}

/** The display fields of any object carrying them (the tab store's state, a lens). */
export function pickTreeDisplay(source: TreeDisplay): TreeDisplay {
  const out = {} as Record<keyof TreeDisplay, unknown>
  for (const key of TREE_DISPLAY_KEYS) {
    const value = source[key]
    out[key] = Array.isArray(value) ? [...value] : value
  }
  return out as TreeDisplay
}

/** Same settings? Filters compare as sets: toggling a chip off and on again is no change. */
export function treeDisplayEqual(a: TreeDisplay, b: TreeDisplay): boolean {
  for (const key of TREE_DISPLAY_KEYS) {
    const x = a[key]
    const y = b[key]
    if (Array.isArray(x) && Array.isArray(y)) {
      const ys = new Set<unknown>(y)
      if (new Set<unknown>(x).size !== ys.size || !x.every((v) => ys.has(v))) return false
    } else if (x !== y) return false
  }
  return true
}

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

/**
 * Display settings read from disk (the saved view state, or a saved lens). Anything
 * missing or malformed takes its default; legacy keys from older releases are read
 * when their replacement is absent.
 */
export function parseTreeDisplay(raw: Record<string, unknown> | null | undefined): TreeDisplay {
  const s = raw ?? {}
  const d = DEFAULT_TREE_DISPLAY
  // Legacy: `treeSubtaskMode` ('hide' | 'match' | 'all') + `treeIncludeAllSubtasks`
  // became the boolean pair `treeShowSubtasks` + `treeShowAllSubtasks`.
  const subtaskMode = s.treeSubtaskMode
  // Legacy: `treeHideInactive`, before that `treeHideClosed`, became `treeShowOnlyActive`.
  const onlyActive =
    typeof s.treeShowOnlyActive === 'boolean'
      ? s.treeShowOnlyActive
      : typeof s.treeHideInactive === 'boolean'
        ? s.treeHideInactive
        : typeof s.treeHideClosed === 'boolean'
          ? s.treeHideClosed
          : d.treeShowOnlyActive
  return {
    treeStatusFilter:
      Array.isArray(s.treeStatusFilter) && s.treeStatusFilter.every((v) => typeof v === 'string')
        ? [...(s.treeStatusFilter as string[])]
        : [...d.treeStatusFilter],
    treePriorityFilter:
      Array.isArray(s.treePriorityFilter) &&
      s.treePriorityFilter.every((v) => typeof v === 'number')
        ? [...(s.treePriorityFilter as number[])]
        : [...d.treePriorityFilter],
    treeShowStatus: bool(s.treeShowStatus, d.treeShowStatus),
    treeShowPriority: bool(s.treeShowPriority, d.treeShowPriority),
    treeShowSubtasks: bool(s.treeShowSubtasks, subtaskMode !== 'hide'),
    treeShowAllSubtasks: bool(
      s.treeShowAllSubtasks,
      subtaskMode === 'all' || s.treeIncludeAllSubtasks === true
    ),
    treeShowAllUndoneSubtasks: bool(s.treeShowAllUndoneSubtasks, d.treeShowAllUndoneSubtasks),
    treeCrossOutDone: bool(s.treeCrossOutDone, d.treeCrossOutDone),
    treeShowOnlyActive: onlyActive,
    treeShowTemporary: bool(s.treeShowTemporary, d.treeShowTemporary),
    treeShowBlocked: bool(s.treeShowBlocked, d.treeShowBlocked),
    treeShowSnoozed: bool(s.treeShowSnoozed, d.treeShowSnoozed),
    treeShowAllOpen: bool(s.treeShowAllOpen, d.treeShowAllOpen),
    treeShowWorktree: bool(s.treeShowWorktree, d.treeShowWorktree),
    treeShowTags: bool(s.treeShowTags, d.treeShowTags),
    treeShowBlockedBadge: bool(s.treeShowBlockedBadge, d.treeShowBlockedBadge),
    treeGroupBy:
      s.treeGroupBy === 'priority' || s.treeGroupBy === 'none' ? s.treeGroupBy : 'status',
    treeOrderBy:
      s.treeOrderBy === 'priority' ||
      s.treeOrderBy === 'due_date' ||
      s.treeOrderBy === 'title' ||
      s.treeOrderBy === 'created' ||
      s.treeOrderBy === 'last_interaction'
        ? s.treeOrderBy
        : 'manual',
    treeOrderDir: s.treeOrderDir === 'desc' ? 'desc' : 'asc',
    treeGroupTemporary: bool(s.treeGroupTemporary, d.treeGroupTemporary),
    treeGroupPinned: bool(s.treeGroupPinned, d.treeGroupPinned),
    treeGroupBlocked: bool(s.treeGroupBlocked, d.treeGroupBlocked),
    treeShowEmptyGroups: bool(s.treeShowEmptyGroups, d.treeShowEmptyGroups)
  }
}
