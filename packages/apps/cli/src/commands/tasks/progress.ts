import { openDb, notifyApp } from '../../db'
import { resolveId } from './_shared'

export async function progressAction(idOrValue: string, value: string | undefined): Promise<void> {
  let idPrefix: string | undefined
  if (value === undefined) {
    idPrefix = undefined
    value = idOrValue
  } else {
    idPrefix = idOrValue
  }
  idPrefix = resolveId(idPrefix)
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || String(n) !== String(value).trim() || n < 0 || n > 100) {
    console.error('progress must be integer 0-100')
    process.exit(1)
  }

  const db = openDb()
  const tasks = db.query<{ id: string; title: string }>(
    `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': idPrefix }
  )
  if (tasks.length === 0) { console.error(`Task not found: ${idPrefix}`); process.exit(1) }
  if (tasks.length > 1) {
    console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  const task = tasks[0]

  db.run(
    `UPDATE tasks SET progress = :p, updated_at = :now WHERE id = :id`,
    { ':p': n, ':now': new Date().toISOString(), ':id': task.id }
  )
  db.close()
  await notifyApp()
  console.log(`Progress ${n}%: ${task.id.slice(0, 8)}  ${task.title}`)
}
