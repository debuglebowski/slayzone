import { openDb } from '../../db'
import { resolveId, type TaskRow } from './_shared'

export async function viewAction(idPrefix: string | undefined): Promise<void> {
  idPrefix = resolveId(idPrefix)
  const db = openDb()

  const tasks = db.query<TaskRow & { description: string; due_date: string }>(
    `SELECT t.*, p.name AS project_name
     FROM tasks t JOIN projects p ON t.project_id = p.id
     WHERE t.id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': idPrefix }
  )

  if (tasks.length === 0) {
    console.error(`Task not found: ${idPrefix}`)
    process.exit(1)
  }
  if (tasks.length > 1) {
    console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }

  const t = tasks[0]

  const tagNames = db.query<{ name: string }>(
    `SELECT tg.name FROM tags tg JOIN task_tags tt ON tg.id = tt.tag_id
     WHERE tt.task_id = :tid ORDER BY tg.sort_order, tg.name`,
    { ':tid': t.id }
  ).map((r) => r.name)

  const blockers = db.query<{ id: string; title: string }>(
    `SELECT t.id, t.title FROM tasks t JOIN task_dependencies td ON t.id = td.task_id
     WHERE td.blocks_task_id = :tid`,
    { ':tid': t.id }
  )
  const blocking = db.query<{ id: string; title: string }>(
    `SELECT t.id, t.title FROM tasks t JOIN task_dependencies td ON t.id = td.blocks_task_id
     WHERE td.task_id = :tid`,
    { ':tid': t.id }
  )
  db.close()

  console.log(`ID:       ${t.id}`)
  console.log(`Title:    ${t.title}`)
  console.log(`Status:   ${t.status}`)
  console.log(`Priority: ${t.priority}`)
  console.log(`Project:  ${t.project_name}`)
  if (t.due_date) console.log(`Due:      ${t.due_date}`)
  if (tagNames.length > 0) console.log(`Tags:     ${tagNames.join(', ')}`)
  if ((t as Record<string, unknown>).is_blocked) {
    const comment = (t as Record<string, unknown>).blocked_comment
    console.log(`Blocked:  yes${comment ? ` (${comment})` : ''}`)
  }
  if (blockers.length > 0) console.log(`Blockers: ${blockers.map((b) => `${b.id.slice(0, 8)} (${b.title})`).join(', ')}`)
  if (blocking.length > 0) console.log(`Blocking: ${blocking.map((b) => `${b.id.slice(0, 8)} (${b.title})`).join(', ')}`)
  console.log(`Created:  ${t.created_at}`)
  if (t.description) console.log(`\n${t.description}`)
}
