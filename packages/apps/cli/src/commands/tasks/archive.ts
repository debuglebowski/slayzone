import { openDb, notifyApp } from '../../db'

export async function archiveAction(idPrefix: string): Promise<void> {
  const db = openDb()

  const tasks = db.query<{ id: string; title: string }>(
    `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' AND archived_at IS NULL LIMIT 2`,
    { ':prefix': idPrefix }
  )

  if (tasks.length === 0) { console.error(`Task not found: ${idPrefix}`); process.exit(1) }
  if (tasks.length > 1) {
    console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }

  const task = tasks[0]
  db.run(`UPDATE tasks SET archived_at = :now, updated_at = :now WHERE id = :id`, {
    ':now': new Date().toISOString(),
    ':id': task.id,
  })

  db.close()
  await notifyApp()
  console.log(`Archived: ${task.id.slice(0, 8)}  ${task.title}`)
}
