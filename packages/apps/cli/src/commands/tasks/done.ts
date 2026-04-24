import { openDb, notifyApp, postJson, getMcpPort } from '../../db'
import { getDoneStatus } from '@slayzone/projects/shared'
import { getProjectColumnsConfig, resolveId } from './_shared'

export interface DoneOpts {
  close?: boolean
}

export async function doneAction(idPrefix: string | undefined, opts: DoneOpts): Promise<void> {
  idPrefix = resolveId(idPrefix)
  const db = openDb()

  const tasks = db.query<{ id: string; title: string; project_id: string }>(
    `SELECT id, title, project_id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
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

  const task = tasks[0]
  const projectColumns = getProjectColumnsConfig(db, task.project_id)
  const doneStatus = getDoneStatus(projectColumns)
  db.run(`UPDATE tasks SET status = :status, updated_at = :now WHERE id = :id`, {
    ':status': doneStatus,
    ':now': new Date().toISOString(),
    ':id': task.id,
  })

  db.close()
  await notifyApp()
  console.log(`Done: ${task.id.slice(0, 8)}  ${task.title}`)

  if (opts.close) {
    const port = getMcpPort()
    if (!port) {
      console.error('Warning: cannot close tab — no MCP port (is the app running?)')
    } else {
      const ok = await postJson(port, `/api/close-task/${task.id}`)
      if (!ok) {
        console.error('Warning: tab close failed — main process likely stale (rebuild + restart app)')
      }
    }
  }
}
