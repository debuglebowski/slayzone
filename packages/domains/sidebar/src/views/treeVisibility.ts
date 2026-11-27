import type { Task } from '@slayzone/task-contracts'
import type { TreeDisplay } from '@slayzone/tabs-state'

/** What decides whether a task shows in the tree, besides the display settings. */
export interface TreeVisibilityInput {
  tasks: Task[]
  display: Pick<
    TreeDisplay,
    | 'treeStatusFilter'
    | 'treePriorityFilter'
    | 'treeShowSubtasks'
    | 'treeShowAllSubtasks'
    | 'treeShowAllUndoneSubtasks'
    | 'treeShowOnlyActive'
    | 'treeShowTemporary'
    | 'treeShowBlocked'
    | 'treeShowSnoozed'
    | 'treeShowAllOpen'
  >
  pinnedIds: ReadonlySet<string>
  /** Tasks with an active agent session — they always show. */
  sessionTaskIds: ReadonlySet<string>
  openTabTaskIds: ReadonlySet<string>
  doneTaskIds?: ReadonlySet<string>
  now?: Date
}

/**
 * The ids of every task the tree shows. A task shows when it passes the filter, or
 * when a descendant in the same project does (so the hierarchy stays connected when
 * only sub-tasks match): parents are walked up from each match.
 *
 * With "all sub-tasks" (or "all undone sub-tasks") on, the filter is applied to roots
 * only — a matching root pulls its whole descendant subtree along.
 */
export function computeVisibleTaskIds({
  tasks,
  display,
  pinnedIds,
  sessionTaskIds,
  openTabTaskIds,
  doneTaskIds,
  now = new Date()
}: TreeVisibilityInput): Set<string> {
  const statusFilter = new Set(display.treeStatusFilter)
  const priorityFilter = new Set(display.treePriorityFilter)
  const isSnoozed = (t: Task) => !!t.snoozed_until && new Date(t.snoozed_until) > now

  const passesFilter = (t: Task): boolean => {
    if (t.archived_at) return false
    // Priority filter is universal — applies even to pinned/open-tab/session
    // tasks. Empty set = no constraint.
    if (priorityFilter.size > 0 && !priorityFilter.has(t.priority)) return false
    // Shortcuts: any of these passes the task straight through, bypassing
    // temp/blocked/snoozed, show-only-active, and status filters.
    if (pinnedIds.has(t.id)) return true
    if (sessionTaskIds.has(t.id)) return true
    if (display.treeShowAllOpen && openTabTaskIds.has(t.id)) return true
    if (!display.treeShowTemporary && t.is_temporary) return false
    if (!display.treeShowBlocked && t.is_blocked) return false
    if (!display.treeShowSnoozed && isSnoozed(t)) return false
    if (display.treeShowOnlyActive) return false
    return statusFilter.has(t.status)
  }

  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const set = new Set<string>()

  // `treeShowOnlyActive` takes precedence — when on, skip the all-subtasks
  // expansion so only bypass tasks (pinned/session/open-tab) + parent chain
  // remain visible, regardless of root status match.
  if (
    display.treeShowSubtasks &&
    !display.treeShowOnlyActive &&
    (display.treeShowAllSubtasks || display.treeShowAllUndoneSubtasks)
  ) {
    const excludeDone = !display.treeShowAllSubtasks && display.treeShowAllUndoneSubtasks
    const childrenOf = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.parent_id) continue
      const list = childrenOf.get(t.parent_id) ?? []
      list.push(t)
      childrenOf.set(t.parent_id, list)
    }
    for (const t of tasks) {
      if (t.parent_id) continue
      if (t.archived_at) continue
      if (!display.treeShowTemporary && t.is_temporary) continue
      if (!display.treeShowBlocked && t.is_blocked) continue
      if (!display.treeShowSnoozed && isSnoozed(t)) continue
      // Strict root check — must directly match status + priority. Bypasses
      // (open tab, pinned, session) don't qualify a root to pull in its subtree.
      if (priorityFilter.size > 0 && !priorityFilter.has(t.priority)) continue
      if (!statusFilter.has(t.status)) continue
      const stack: Task[] = [t]
      while (stack.length > 0) {
        const cur = stack.pop()!
        if (set.has(cur.id) || cur.archived_at) continue
        // Root passes filter, so include regardless of done. Descendants only
        // gated by excludeDone — keeps a matching root visible even if done.
        if (excludeDone && cur.id !== t.id && doneTaskIds?.has(cur.id)) continue
        // Priority filter applies to descendants too.
        if (cur.id !== t.id && priorityFilter.size > 0 && !priorityFilter.has(cur.priority))
          continue
        // Blocked/snoozed filters apply to descendants too.
        if (cur.id !== t.id && !display.treeShowBlocked && cur.is_blocked) continue
        if (cur.id !== t.id && !display.treeShowSnoozed && isSnoozed(cur)) continue
        set.add(cur.id)
        const kids = childrenOf.get(cur.id)
        if (kids) for (const k of kids) stack.push(k)
      }
    }
    // Individual tasks (root or sub-task) that pass via bypass (e.g. open-tab)
    // but whose strict-root subtree wasn't pulled in. Include the task itself +
    // parent chain so the row shows and stays connected.
    for (const t of tasks) {
      if (set.has(t.id) || t.archived_at) continue
      if (!passesFilter(t)) continue
      let cur: Task | undefined = t
      while (cur && !set.has(cur.id) && !cur.archived_at) {
        set.add(cur.id)
        cur = cur.parent_id ? taskById.get(cur.parent_id) : undefined
      }
    }
    return set
  }

  for (const t of tasks) {
    if (!passesFilter(t)) continue
    // When sub-tasks hidden, only top-level tasks are eligible.
    if (!display.treeShowSubtasks && t.parent_id) continue
    let cur: Task | undefined = t
    while (cur && !set.has(cur.id)) {
      set.add(cur.id)
      if (!display.treeShowSubtasks) break
      cur = cur.parent_id ? taskById.get(cur.parent_id) : undefined
    }
  }
  return set
}
