import { openDb } from '../../db'
import { printTasks, resolveId, type TaskRow } from './_shared'

export interface BlockingOpts {
  json?: boolean
}

export async function blockingAction(taskId: string | undefined, opts: BlockingOpts): Promise<void> {
  taskId = resolveId(taskId)
  const db = openDb()

  const tasks = db.query<{ id: string }>(
    `SELECT id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': taskId }
  )
  if (tasks.length === 0) { console.error(`Task not found: ${taskId}`); process.exit(1) }
  if (tasks.length > 1) {
    console.error(`Ambiguous id prefix "${taskId}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }

  const task = tasks[0]

  const blocking = db.query<TaskRow>(
    `SELECT t.id, t.project_id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
     FROM tasks t JOIN task_dependencies td ON t.id = td.blocks_task_id
     JOIN projects p ON t.project_id = p.id
     WHERE td.task_id = :tid`,
    { ':tid': task.id }
  )
  db.close()

  if (opts.json) {
    console.log(JSON.stringify(blocking, null, 2))
  } else if (blocking.length > 0) {
    printTasks(blocking)
  } else {
    console.log('Not blocking any tasks.')
  }
}
