import { openDb } from '../../db'
import { apiPatch } from '../../api'
import { resolveId } from './_shared'

export async function progressAction(idOrValue: string, value: string | undefined): Promise<void> {
  let idPrefix: string | undefined
  if (value === undefined) {
    idPrefix = undefined
    value = idOrValue
  } else {
    idPrefix = idOrValue
  }
  idPrefix = await resolveId(idPrefix)
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
  db.close()
  if (tasks.length === 0) {
    console.error(`Task not found: ${idPrefix}`)
    process.exit(1)
  }
  if (tasks.length > 1) {
    console.error(
      `Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`
    )
    process.exit(1)
  }
  const task = tasks[0]

  await apiPatch(`/api/tasks/${task.id}`, { progress: n })
  console.log(`Progress ${n}%: ${task.id.slice(0, 8)}  ${task.title}`)
}
