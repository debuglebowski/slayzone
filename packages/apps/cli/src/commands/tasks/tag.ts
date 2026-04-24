import { openDb, notifyApp } from '../../db'
import { resolveId } from './_shared'

export interface TagOpts {
  set?: string[]
  add?: string
  remove?: string
  clear?: boolean
  json?: boolean
}

export async function tagAction(taskId: string | undefined, opts: TagOpts): Promise<void> {
  taskId = resolveId(taskId)
  const db = openDb()

  const tasks = db.query<{ id: string; project_id: string }>(
    `SELECT id, project_id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': taskId }
  )
  if (tasks.length === 0) { console.error(`Task not found: ${taskId}`); process.exit(1) }
  if (tasks.length > 1) {
    console.error(`Ambiguous id prefix "${taskId}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }

  const task = tasks[0]

  function resolveTagByName(name: string): string {
    const tags = db.query<{ id: string; name: string }>(
      `SELECT id, name FROM tags WHERE project_id = :pid AND LOWER(name) = LOWER(:name)`,
      { ':pid': task.project_id, ':name': name }
    )
    if (tags.length === 0) {
      console.error(`Tag not found: "${name}" in this project`)
      process.exit(1)
    }
    return tags[0].id
  }

  const isWrite = opts.set || opts.add || opts.remove || opts.clear

  if (isWrite) {
    db.run('BEGIN')
    try {
      if (opts.set) {
        const tagIds = opts.set.map(resolveTagByName)
        db.run(`DELETE FROM task_tags WHERE task_id = :tid`, { ':tid': task.id })
        for (const tagId of tagIds) {
          db.run(`INSERT INTO task_tags (task_id, tag_id) VALUES (:tid, :tagId)`, { ':tid': task.id, ':tagId': tagId })
        }
      } else if (opts.add) {
        const tagId = resolveTagByName(opts.add)
        db.run(
          `INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (:tid, :tagId)`,
          { ':tid': task.id, ':tagId': tagId }
        )
      } else if (opts.remove) {
        const tagId = resolveTagByName(opts.remove)
        db.run(`DELETE FROM task_tags WHERE task_id = :tid AND tag_id = :tagId`, { ':tid': task.id, ':tagId': tagId })
      } else if (opts.clear) {
        db.run(`DELETE FROM task_tags WHERE task_id = :tid`, { ':tid': task.id })
      }
      db.run('COMMIT')
    } catch (e) {
      db.run('ROLLBACK')
      throw e
    }
  }

  // Show current tags
  const tagNames = db.query<{ name: string }>(
    `SELECT tg.name FROM tags tg JOIN task_tags tt ON tg.id = tt.tag_id
     WHERE tt.task_id = :tid ORDER BY tg.sort_order, tg.name`,
    { ':tid': task.id }
  ).map((r) => r.name)
  db.close()

  if (isWrite) await notifyApp()

  if (opts.json) {
    console.log(JSON.stringify(tagNames))
  } else if (tagNames.length > 0) {
    console.log(tagNames.join(', '))
  } else {
    console.log('No tags.')
  }
}
