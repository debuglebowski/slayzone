import { openDb, notifyApp } from '../../db'
import { resolveStatusId } from '@slayzone/projects/shared'
import { validateReparent, reparentErrorMessage, type ReparentTaskRow } from '@slayzone/task/shared/reparent-validation'
import { getProjectColumnsConfig, resolveId } from './_shared'

export interface UpdateOpts {
  title?: string
  description?: string
  appendDescription?: string
  status?: string
  priority?: string
  due?: string | false
  parent?: string | false
  permanent?: boolean
}

export async function updateAction(idPrefix: string | undefined, opts: UpdateOpts): Promise<void> {
  idPrefix = resolveId(idPrefix)
  if (opts.description !== undefined && opts.appendDescription !== undefined) {
    console.error('Cannot use both --description and --append-description.')
    process.exit(1)
  }
  if (opts.title === undefined && opts.description === undefined && opts.appendDescription === undefined && opts.status === undefined
    && opts.priority === undefined && opts.due === undefined && opts.parent === undefined && !opts.permanent) {
    console.error('Provide at least one of --title, --description, --append-description, --status, --priority, --due, --no-due, --parent, --no-parent, --permanent')
    process.exit(1)
  }

  const db = openDb()

  const tasks = db.query<{ id: string; title: string; project_id: string; description: string | null }>(
    `SELECT id, title, project_id, description FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': idPrefix }
  )

  if (tasks.length === 0) { console.error(`Task not found: ${idPrefix}`); process.exit(1) }
  if (tasks.length > 1) {
    console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }

  if (opts.priority) {
    const p = parseInt(opts.priority, 10)
    if (isNaN(p) || p < 1 || p > 5) { console.error('Priority must be 1-5.'); process.exit(1) }
  }

  const task = tasks[0]
  let resolvedStatus: string | undefined
  if (opts.status) {
    const taskColumns = getProjectColumnsConfig(db, task.project_id)
    resolvedStatus = resolveStatusId(opts.status, taskColumns) ?? undefined
    if (!resolvedStatus) {
      console.error(`Unknown status "${opts.status}" for this task's project.`)
      process.exit(1)
    }
  }
  const sets: string[] = ['updated_at = :now']
  const params: Record<string, string | number | null> = { ':now': new Date().toISOString(), ':id': task.id }

  let resolvedParentId: string | null | undefined
  if (opts.parent === false) {
    resolvedParentId = null
  } else if (typeof opts.parent === 'string') {
    const parentMatches = db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
      { ':prefix': opts.parent }
    )
    if (parentMatches.length === 0) { console.error(`Parent task not found: ${opts.parent}`); process.exit(1) }
    if (parentMatches.length > 1) {
      console.error(`Ambiguous parent id prefix "${opts.parent}". Matches: ${parentMatches.map((t) => t.id.slice(0, 8)).join(', ')}`)
      process.exit(1)
    }
    resolvedParentId = parentMatches[0].id
  }
  if (resolvedParentId !== undefined) {
    const result = validateReparent({
      taskId: task.id,
      parentId: resolvedParentId,
      lookup: (id: string) => {
        const rows = db.query<ReparentTaskRow>(
          `SELECT id, project_id, parent_id, archived_at, deleted_at FROM tasks WHERE id = :id LIMIT 1`,
          { ':id': id }
        )
        return rows[0] ?? null
      },
    })
    if (!result.ok) {
      console.error(reparentErrorMessage(result.error, { taskId: task.id, parentId: resolvedParentId }))
      process.exit(1)
    }
  }

  if (opts.title)       { sets.push('title = :title');             params[':title'] = opts.title }
  if (opts.description !== undefined) { sets.push('description = :description'); params[':description'] = opts.description || null }
  if (opts.appendDescription) { sets.push('description = :description'); params[':description'] = (task.description ?? '') + '\n' + opts.appendDescription }
  if (resolvedStatus)   { sets.push('status = :status');           params[':status'] = resolvedStatus }
  if (opts.priority)    { sets.push('priority = :priority');       params[':priority'] = parseInt(opts.priority, 10) }
  if (typeof opts.due === 'string') { sets.push('due_date = :dueDate'); params[':dueDate'] = opts.due }
  else if (opts.due === false)      { sets.push('due_date = NULL') }
  if (resolvedParentId !== undefined) { sets.push('parent_id = :parentId'); params[':parentId'] = resolvedParentId }
  if (opts.permanent)   { sets.push('is_temporary = 0') }

  db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = :id`, params)
  db.close()
  await notifyApp()
  console.log(`Updated: ${task.id.slice(0, 8)}  ${opts.title ?? task.title}`)
}
