import { openDb, notifyApp } from '../../db'
import { printTasks, resolveId, type TaskRow } from './_shared'

export interface BlockersOpts {
  add?: string[]
  remove?: string[]
  set?: string[]
  clear?: boolean
  json?: boolean
}

export async function blockersAction(taskId: string | undefined, opts: BlockersOpts): Promise<void> {
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

  function resolveTaskId(prefix: string): string {
    if (prefix === task.id || prefix === task.id.slice(0, prefix.length)) {
      // Check exact self-reference
      if (prefix === task.id || db.query<{ id: string }>(`SELECT id FROM tasks WHERE id LIKE :p || '%' LIMIT 1`, { ':p': prefix })[0]?.id === task.id) {
        console.error(`A task cannot block itself.`)
        process.exit(1)
      }
    }
    const matches = db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE id LIKE :p || '%' LIMIT 2`,
      { ':p': prefix }
    )
    if (matches.length === 0) { console.error(`Task not found: ${prefix}`); process.exit(1) }
    if (matches.length > 1) {
      console.error(`Ambiguous id prefix "${prefix}". Matches: ${matches.map((t) => t.id.slice(0, 8)).join(', ')}`)
      process.exit(1)
    }
    if (matches[0].id === task.id) {
      console.error(`A task cannot block itself.`)
      process.exit(1)
    }
    return matches[0].id
  }

  const isWrite = opts.add || opts.remove || opts.set || opts.clear

  if (isWrite) {
    db.run('BEGIN')
    try {
      if (opts.set) {
        const blockerIds = opts.set.map(resolveTaskId)
        db.run(`DELETE FROM task_dependencies WHERE blocks_task_id = :tid`, { ':tid': task.id })
        for (const bid of blockerIds) {
          db.run(`INSERT OR IGNORE INTO task_dependencies (task_id, blocks_task_id) VALUES (:bid, :tid)`, { ':bid': bid, ':tid': task.id })
        }
      } else if (opts.add) {
        for (const prefix of opts.add) {
          const bid = resolveTaskId(prefix)
          db.run(`INSERT OR IGNORE INTO task_dependencies (task_id, blocks_task_id) VALUES (:bid, :tid)`, { ':bid': bid, ':tid': task.id })
        }
      } else if (opts.remove) {
        for (const prefix of opts.remove) {
          const bid = resolveTaskId(prefix)
          db.run(`DELETE FROM task_dependencies WHERE task_id = :bid AND blocks_task_id = :tid`, { ':bid': bid, ':tid': task.id })
        }
      } else if (opts.clear) {
        db.run(`DELETE FROM task_dependencies WHERE blocks_task_id = :tid`, { ':tid': task.id })
      }
      db.run('COMMIT')
    } catch (e) {
      db.run('ROLLBACK')
      throw e
    }
  }

  // Show current blockers
  const blockers = db.query<TaskRow>(
    `SELECT t.id, t.project_id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
     FROM tasks t JOIN task_dependencies td ON t.id = td.task_id
     JOIN projects p ON t.project_id = p.id
     WHERE td.blocks_task_id = :tid`,
    { ':tid': task.id }
  )
  db.close()

  if (isWrite) await notifyApp()

  if (opts.json) {
    console.log(JSON.stringify(blockers, null, 2))
  } else if (blockers.length > 0) {
    printTasks(blockers)
  } else {
    console.log('No blockers.')
  }
}
