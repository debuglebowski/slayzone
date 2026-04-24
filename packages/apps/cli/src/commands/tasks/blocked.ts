import { openDb, notifyApp } from '../../db'
import { resolveId } from './_shared'

export interface BlockedOpts {
  on?: boolean
  off?: boolean
  toggle?: boolean
  comment?: string | false
  json?: boolean
}

export async function blockedAction(taskId: string | undefined, opts: BlockedOpts): Promise<void> {
  taskId = resolveId(taskId)
  const db = openDb()

  const tasks = db.query<{ id: string; is_blocked: number; blocked_comment: string | null }>(
    `SELECT id, is_blocked, blocked_comment FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': taskId }
  )
  if (tasks.length === 0) { console.error(`Task not found: ${taskId}`); process.exit(1) }
  if (tasks.length > 1) {
    console.error(`Ambiguous id prefix "${taskId}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }

  const task = tasks[0]
  const now = new Date().toISOString()

  if (opts.on) {
    db.run(`UPDATE tasks SET is_blocked = 1, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
  } else if (opts.off) {
    db.run(`UPDATE tasks SET is_blocked = 0, blocked_comment = NULL, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
  } else if (opts.toggle) {
    const newVal = task.is_blocked ? 0 : 1
    if (newVal === 0) {
      db.run(`UPDATE tasks SET is_blocked = 0, blocked_comment = NULL, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
    } else {
      db.run(`UPDATE tasks SET is_blocked = 1, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
    }
  } else if (opts.comment !== undefined && opts.comment !== false) {
    db.run(`UPDATE tasks SET is_blocked = 1, blocked_comment = :comment, updated_at = :now WHERE id = :id`, { ':comment': opts.comment, ':now': now, ':id': task.id })
  } else if (opts.comment === false) {
    // --no-comment (commander sets opts.comment = false when --no-comment is used)
    db.run(`UPDATE tasks SET blocked_comment = NULL, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
  }

  const isWrite = opts.on || opts.off || opts.toggle || opts.comment !== undefined

  // Re-read current state
  const updated = db.query<{ is_blocked: number; blocked_comment: string | null }>(
    `SELECT is_blocked, blocked_comment FROM tasks WHERE id = :id`,
    { ':id': task.id }
  )[0]

  // Also show dependency-based blockers for context
  const blockers = db.query<{ id: string; title: string }>(
    `SELECT t.id, t.title FROM tasks t JOIN task_dependencies td ON t.id = td.task_id
     WHERE td.blocks_task_id = :tid`,
    { ':tid': task.id }
  )
  db.close()

  if (isWrite) await notifyApp()

  if (opts.json) {
    console.log(JSON.stringify({
      is_blocked: Boolean(updated.is_blocked),
      blocked_comment: updated.blocked_comment,
      blockers: blockers.map((b) => ({ id: b.id, title: b.title })),
    }, null, 2))
  } else {
    console.log(`Blocked: ${updated.is_blocked ? 'yes' : 'no'}${updated.blocked_comment ? ` (${updated.blocked_comment})` : ''}`)
    if (blockers.length > 0) {
      console.log(`Blockers: ${blockers.map((b) => `${b.id.slice(0, 8)} (${b.title})`).join(', ')}`)
    }
  }
}
