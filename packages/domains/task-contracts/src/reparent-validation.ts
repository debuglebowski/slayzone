export interface ReparentTaskRow {
  id: string
  project_id: string
  parent_id: string | null
  archived_at?: string | null
  deleted_at?: string | null
}

export type ReparentError =
  | 'self'
  | 'cycle'
  | 'cross-project'
  | 'archived-parent'
  | 'missing-parent'
  | 'missing-task'

export type ReparentValidation = { ok: true } | { ok: false; error: ReparentError }

export interface ValidateReparentOptions {
  taskId: string
  parentId: string | null
  targetProjectId?: string
  lookup: (id: string) => ReparentTaskRow | null
}

export function validateReparent(opts: ValidateReparentOptions): ReparentValidation {
  const { taskId, parentId, targetProjectId, lookup } = opts

  const task = lookup(taskId)
  if (!task) return { ok: false, error: 'missing-task' }

  if (parentId === null) return { ok: true }

  if (parentId === taskId) return { ok: false, error: 'self' }

  const parent = lookup(parentId)
  if (!parent) return { ok: false, error: 'missing-parent' }
  if (parent.archived_at || parent.deleted_at) return { ok: false, error: 'archived-parent' }

  const projectId = targetProjectId ?? task.project_id
  if (parent.project_id !== projectId) return { ok: false, error: 'cross-project' }

  // Walk upward from parent; if taskId appears, cycle.
  const seen = new Set<string>()
  let cursor: string | null = parent.id
  while (cursor) {
    if (cursor === taskId) return { ok: false, error: 'cycle' }
    if (seen.has(cursor)) break
    seen.add(cursor)
    const row = lookup(cursor)
    cursor = row?.parent_id ?? null
  }

  return { ok: true }
}

export function reparentErrorMessage(
  error: ReparentError,
  ids: { taskId: string; parentId: string | null }
): string {
  switch (error) {
    case 'self':
      return `Cannot make task its own parent (${ids.taskId.slice(0, 8)})`
    case 'cycle':
      return `Reparent would create a cycle`
    case 'cross-project':
      return `Parent task is in a different project`
    case 'archived-parent':
      return `Parent task is archived or deleted`
    case 'missing-parent':
      return `Parent task not found: ${ids.parentId?.slice(0, 8) ?? '(null)'}`
    case 'missing-task':
      return `Task not found: ${ids.taskId.slice(0, 8)}`
  }
}
