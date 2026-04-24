import { openDb, notifyApp } from '../../db'

export async function deleteAction(idPrefix: string): Promise<void> {
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
  db.run(`DELETE FROM tasks WHERE id = :id`, { ':id': task.id })
  db.close()
  await notifyApp()
  console.log(`Deleted: ${task.id.slice(0, 8)}  ${task.title}`)
}
