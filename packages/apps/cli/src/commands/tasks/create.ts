import { resolveProjectArg } from '../../db'
import { apiPost } from '../../api'

export interface CreateOpts {
  project?: string
  description?: string
  status?: string
  priority?: string
  due?: string
  template?: string
  externalId?: string
  externalProvider?: string
}

export async function createAction(title: string, opts: CreateOpts): Promise<void> {
  // `resolveProjectArg` only reads the flag and $SLAYZONE_PROJECT_ID — no DB.
  const projectRef = resolveProjectArg(opts.project)

  // Client-side priority guard (CLI parity: the same message the route would
  // return, but before the network round-trip). Mirrors `subtask-add`.
  if (opts.priority) {
    const p = parseInt(opts.priority, 10)
    if (isNaN(p) || p < 1 || p > 5) {
      console.error('Priority must be 1-5.')
      process.exit(1)
    }
  }

  // POST /api/tasks owns project-ref resolution, status-alias resolution against
  // that project's columns, template ref (id prefix | name) resolution, and
  // external-id dedupe — returning the existing row with `existing: true` instead
  // of inserting. The external id rides along on the CREATE, so the hub writes it
  // in the same transaction as the insert and emits one change; this command used
  // to patch it in with a direct UPDATE afterwards, which the hub never saw.
  //
  // All of that used to run here against the hub's SQLite file, which is why
  // `tasks create` could never work against a hub on another machine.
  const { data: task, existing, project } = await apiPost<{
    ok: true
    data: { id: string; title: string; status: string }
    existing?: boolean
    project: { id: string; name: string }
  }>('/api/tasks', {
    project: projectRef,
    title,
    description: opts.description,
    status: opts.status,
    priority: opts.priority ? parseInt(opts.priority, 10) : undefined,
    dueDate: opts.due,
    template: opts.template,
    externalId: opts.externalId,
    externalProvider: opts.externalProvider
  })

  if (existing) {
    console.log(
      `Exists: ${task.id.slice(0, 8)}  ${task.title}  [${task.status}]  ${project.name}`
    )
    return
  }
  console.log(`Created: ${task.id.slice(0, 8)}  ${title}  [${task.status}]  ${project.name}`)
}
