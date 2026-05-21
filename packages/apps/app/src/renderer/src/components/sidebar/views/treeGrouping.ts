import type { Task } from '@slayzone/task/shared'
import { DEFAULT_COLUMNS, type ColumnConfig } from '@slayzone/projects/shared'
import type { TreeGroupBy, TreeOrderBy, TreeOrderDir } from '@slayzone/settings'

export const TEMP_GROUP_KEY = '__temporary__'
export const PINNED_GROUP_KEY = '__pinned__'
export const NONE_GROUP_KEY = '__none__'

export interface TreeGroup {
  /** groupValue — matches what `moveTask` expects (status id, or 'p1'..'p5'). */
  key: string
  isTemp: boolean
  isPinned: boolean
  /** Ungrouped bucket — `groupBy === 'none'`. Suppresses header + add-button. */
  isNone?: boolean
  tasks: Task[]
}

/**
 * Tree-local sort. Tiebreaks by `tiebreakKey` so manual drag-reorder persists
 * under any orderBy — `order` for normal groups, `pin_order` for the pinned
 * group (whose manual order is task-intrinsic). Independent of kanban's
 * `sortTasks` so kanban tiebreaker semantics stay untouched.
 */
export function orderTreeRows(
  tasks: Task[],
  orderBy: TreeOrderBy,
  dir: TreeOrderDir,
  tiebreakKey: 'order' | 'pin_order' = 'order'
): Task[] {
  const sorted = [...tasks].sort((a, b) => {
    let cmp = 0
    switch (orderBy) {
      case 'priority':
        cmp = a.priority - b.priority
        break
      case 'due_date':
        if (!a.due_date && !b.due_date) cmp = 0
        else if (!a.due_date) cmp = 1
        else if (!b.due_date) cmp = -1
        else cmp = a.due_date.localeCompare(b.due_date)
        break
      case 'title':
        cmp = a.title.localeCompare(b.title)
        break
      case 'created':
        // newest first by default
        cmp = b.created_at.localeCompare(a.created_at)
        break
      case 'last_interaction': {
        // Newest interaction first. Null → bottom. Bumped by chat user-messages
        // and agent_turns inserts; see migrations v139.
        const av = a.last_interaction_at
        const bv = b.last_interaction_at
        if (av == null && bv == null) cmp = 0
        else if (av == null) cmp = 1
        else if (bv == null) cmp = -1
        else cmp = bv - av
        break
      }
      case 'manual':
      default:
        cmp = 0
    }
    if (cmp !== 0) return cmp
    return a[tiebreakKey] - b[tiebreakKey]
  })
  return dir === 'desc' ? sorted.reverse() : sorted
}

export interface GroupOpts {
  showEmpty: boolean
  statusFilter: Set<string>
  groupTemporary: boolean
  groupPinned: boolean
  pinnedIds: Set<string>
}

/**
 * Bucket roots into groups according to `groupBy`. Pinned tasks split into
 * their own group when `groupPinned` is on (winning over temp). Temp tasks
 * split into their own group when `groupTemporary` is on. Otherwise mixed
 * into their natural status/priority bucket.
 *
 * When `showEmpty` is on:
 * - groupBy='status': render every column from `columns` even if empty, but
 *   still respect `statusFilter` (filter wins — a column hidden by filter
 *   stays hidden).
 * - groupBy='priority': render all 5 buckets (p1..p5).
 */
export function groupTreeRows(
  roots: Task[],
  groupBy: TreeGroupBy,
  columns: ColumnConfig[] | null,
  opts: GroupOpts
): TreeGroup[] {
  const groups: TreeGroup[] = []
  const pinnedTasks: Task[] = []
  const tempTasks: Task[] = []
  const persistent: Task[] = []
  for (const t of roots) {
    if (opts.groupPinned && opts.pinnedIds.has(t.id)) pinnedTasks.push(t)
    else if (opts.groupTemporary && t.is_temporary) tempTasks.push(t)
    else persistent.push(t)
  }

  if (pinnedTasks.length > 0) {
    groups.push({ key: PINNED_GROUP_KEY, isTemp: false, isPinned: true, tasks: pinnedTasks })
  }

  // Temporary group renders last — append right before each return path.
  const appendTemp = (): TreeGroup[] => {
    if (tempTasks.length > 0) {
      groups.push({ key: TEMP_GROUP_KEY, isTemp: true, isPinned: false, tasks: tempTasks })
    }
    return groups
  }

  if (groupBy === 'none') {
    // Single ungrouped bucket. Pinned/temp still split when their toggles on,
    // so users can pull those to the top without forcing status/priority bins.
    if (persistent.length > 0 || opts.showEmpty) {
      groups.push({
        key: NONE_GROUP_KEY,
        isTemp: false,
        isPinned: false,
        isNone: true,
        tasks: persistent
      })
    }
    return appendTemp()
  }

  if (groupBy === 'status') {
    const byKey = new Map<string, Task[]>()
    for (const t of persistent) {
      const arr = byKey.get(t.status) ?? []
      arr.push(t)
      byKey.set(t.status, arr)
    }
    if (opts.showEmpty) {
      const effective = columns ?? DEFAULT_COLUMNS
      const ordered = [...effective].sort((a, b) => a.position - b.position)
      for (const col of ordered) {
        if (opts.statusFilter.size > 0 && !opts.statusFilter.has(col.id)) continue
        groups.push({ key: col.id, isTemp: false, isPinned: false, tasks: byKey.get(col.id) ?? [] })
        byKey.delete(col.id)
      }
      // Any leftover statuses not in columns config (legacy).
      for (const [k, arr] of byKey)
        groups.push({ key: k, isTemp: false, isPinned: false, tasks: arr })
    } else {
      // Preserve column position order for known statuses.
      const seen = new Set<string>()
      if (columns) {
        const ordered = [...columns].sort((a, b) => a.position - b.position)
        for (const col of ordered) {
          const arr = byKey.get(col.id)
          if (!arr || arr.length === 0) continue
          groups.push({ key: col.id, isTemp: false, isPinned: false, tasks: arr })
          seen.add(col.id)
        }
      }
      for (const [k, arr] of byKey) {
        if (seen.has(k)) continue
        groups.push({ key: k, isTemp: false, isPinned: false, tasks: arr })
      }
    }
    return appendTemp()
  }

  // groupBy === 'priority'
  const byPrio = new Map<number, Task[]>()
  for (const t of persistent) {
    const p = typeof t.priority === 'number' ? t.priority : 5
    const arr = byPrio.get(p) ?? []
    arr.push(t)
    byPrio.set(p, arr)
  }
  const prioRange = opts.showEmpty
    ? [1, 2, 3, 4, 5]
    : Array.from(byPrio.keys()).sort((a, b) => a - b)
  for (const p of prioRange) {
    const arr = byPrio.get(p) ?? []
    if (!opts.showEmpty && arr.length === 0) continue
    groups.push({ key: `p${p}`, isTemp: false, isPinned: false, tasks: arr })
  }
  return appendTemp()
}
