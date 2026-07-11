import { apiPost } from '../../api'
import { resolveId } from './_shared'

export interface SubtaskAddOpts {
  parent?: string
  description?: string
  status?: string
  priority?: string
  externalId?: string
  externalProvider?: string
}

export async function subtaskAddAction(title: string, opts: SubtaskAddOpts): Promise<void> {
  const parentId = await resolveId(opts.parent)

  // Client-side priority guard (CLI parity: fail fast with the same message the
  // route would return, but before the network round-trip).
  const priority = parseInt(opts.priority ?? '3', 10)
  if (isNaN(priority) || priority < 1 || priority > 5) {
    console.error('Priority must be 1-5.')
    process.exit(1)
  }

  // POST /api/tasks/:id/subtasks owns parent id-prefix resolution, status-alias
  // resolution against the parent's columns, terminal-mode + provider-config
  // snapshotting, and external-id dedupe (returns the existing row with
  // `existing: true` instead of inserting).
  const { data, existing } = await apiPost<{
    ok: true
    data: { id: string; title: string; status: string }
    existing?: boolean
  }>(`/api/tasks/${encodeURIComponent(parentId)}/subtasks`, {
    title,
    description: opts.description,
    status: opts.status,
    priority,
    externalId: opts.externalId,
    externalProvider: opts.externalProvider
  })

  if (existing) {
    console.log(`Exists: ${data.id.slice(0, 8)}  ${data.title}  [${data.status}]`)
    return
  }
  console.log(`Created subtask: ${data.id.slice(0, 8)}  ${title}`)
}
