import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'

/** Structural shape of `task.loadBoardData` (client view — rows are the shared
 *  Task/Project/Tag types). Mirrors the server op's return without importing
 *  the electron-coupled server module into renderer code. */
export type BoardData = {
  tasks: Task[]
  projects: Project[]
  tags: Tag[]
  taskTags: Record<string, string[]>
  blockedTaskIds: string[]
}

/** Structural shape of `task.loadBoardRows` — the board slice of some tasks. */
export type BoardRows = {
  tasks: Task[]
  taskTags: Record<string, string[]>
  blockedTaskIds: string[]
}

/** More changed rows than this in one event → reload the board instead. */
export const MAX_PATCH_ROWS = 200

/**
 * Patch the rows of `ids` into a board, from their freshly loaded slice.
 *
 * Returns null when a patch cannot reproduce what a full reload would show, so
 * the caller reloads instead:
 * - a row that is not on the board yet (a create): where it sorts depends on
 *   SQL ordering (`order`, `created_at`, rowid) the client cannot replicate;
 * - a row whose `order` or `created_at` changed: same reason — it may move.
 *
 * A requested id missing from `rows.tasks` was deleted → dropped. Every other
 * row keeps its object identity, so memoized consumers skip re-rendering.
 */
export function patchBoardRows(
  prev: BoardData,
  ids: readonly string[],
  rows: BoardRows
): BoardData | null {
  const wanted = new Set(ids)
  const fresh = new Map(rows.tasks.map((t) => [t.id, t]))
  const onBoard = new Set<string>()
  const tasks: Task[] = []
  for (const t of prev.tasks) {
    if (!wanted.has(t.id)) {
      tasks.push(t)
      continue
    }
    onBoard.add(t.id)
    const next = fresh.get(t.id)
    if (!next) continue // deleted
    if (next.order !== t.order || next.created_at !== t.created_at) return null
    tasks.push(next)
  }
  for (const id of fresh.keys()) if (!onBoard.has(id)) return null

  const taskTags: Record<string, string[]> = { ...prev.taskTags }
  for (const id of wanted) {
    const tagIds = rows.taskTags[id]
    if (tagIds) taskTags[id] = tagIds
    else delete taskTags[id]
  }
  const blocked = new Set(rows.blockedTaskIds)
  const blockedTaskIds = prev.blockedTaskIds.filter((id) => !wanted.has(id))
  for (const id of wanted) if (blocked.has(id)) blockedTaskIds.push(id)

  return { ...prev, tasks, taskTags, blockedTaskIds }
}

/** Parents of the given tasks, before and after the change — their sub-task
 *  lists show these rows. */
export function parentIdsOf(
  ids: readonly string[],
  before: readonly Task[] | undefined,
  after: readonly Task[]
): string[] {
  const wanted = new Set(ids)
  const parents = new Set<string>()
  for (const list of [before ?? [], after]) {
    for (const t of list) if (wanted.has(t.id) && t.parent_id) parents.add(t.parent_id)
  }
  return [...parents]
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Three-way merge of one row: what the server changed since `base` (the board's
 * previous copy) wins; every field the server did NOT change keeps the local
 * value. Local = the renderer's mirror, which may hold an optimistic edit whose
 * own write has not landed yet (a drag writes `status` then `order` as two
 * mutations → two events): a patch for the first must not undo the second's
 * optimistic half. Untouched local rows (local === base) take the server row
 * as is, keeping its identity.
 */
export function mergeRow<T extends object>(base: T | undefined, local: T, remote: T): T {
  if (!base || local === base) return remote
  const out = { ...local } as Record<string, unknown>
  const b = base as Record<string, unknown>
  const r = remote as Record<string, unknown>
  for (const k of new Set([...Object.keys(b), ...Object.keys(r)])) {
    if (!sameValue(b[k], r[k])) out[k] = r[k]
  }
  return out as T
}

/** Apply a patch (`prev` → `next` board) to the renderer's task mirror. */
export function patchMirrorTasks(
  mirror: Task[],
  ids: readonly string[],
  prev: BoardData,
  next: BoardData
): Task[] {
  const wanted = new Set(ids)
  const base = new Map(prev.tasks.filter((t) => wanted.has(t.id)).map((t) => [t.id, t]))
  const fresh = new Map(next.tasks.filter((t) => wanted.has(t.id)).map((t) => [t.id, t]))
  const out: Task[] = []
  for (const t of mirror) {
    if (!wanted.has(t.id)) {
      out.push(t)
      continue
    }
    const remote = fresh.get(t.id)
    if (!remote) continue // deleted on the server
    out.push(mergeRow(base.get(t.id), t, remote))
  }
  return out
}

/** Same rule for the tag-id map: a task's tags take the server's set only when
 *  the server's set changed. */
export function patchMirrorTaskTags(
  mirror: Map<string, string[]>,
  ids: readonly string[],
  prev: BoardData,
  next: BoardData
): Map<string, string[]> {
  const out = new Map(mirror)
  for (const id of ids) {
    const before = prev.taskTags[id]
    const after = next.taskTags[id]
    if (sameValue(before ?? [], after ?? [])) continue
    if (after) out.set(id, after)
    else out.delete(id)
  }
  return out
}

/** Same rule for the blocked set. */
export function patchMirrorBlocked(
  mirror: Set<string>,
  ids: readonly string[],
  prev: BoardData,
  next: BoardData
): Set<string> {
  const before = new Set(prev.blockedTaskIds)
  const after = new Set(next.blockedTaskIds)
  const out = new Set(mirror)
  for (const id of ids) {
    if (before.has(id) === after.has(id)) continue
    if (after.has(id)) out.add(id)
    else out.delete(id)
  }
  return out
}
