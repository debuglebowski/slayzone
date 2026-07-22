import http from 'node:http'
import { openDb, getServerPort } from '../../db'
import { apiPost } from '../../api'
import { resolveId } from './_shared'

export interface OpenOpts {
  background?: boolean
  start?: boolean
  wait?: boolean
  timeout?: string
}

export async function openAction(idPrefix: string | undefined, opts: OpenOpts = {}): Promise<void> {
  idPrefix = await resolveId(idPrefix)
  const db = openDb()

  const tasks = db.query<{ id: string; title: string }>(
    `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': idPrefix }
  )

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
  db.close()

  const port = getServerPort()
  if (!port) {
    console.error('No running SlayZone app found. Start the app first.')
    process.exit(1)
  }

  const path = opts.background
    ? `/api/open-task/${task.id}?background=1`
    : `/api/open-task/${task.id}`

  await new Promise<void>((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', () => {
      console.error('Failed to reach SlayZone app. Is it running?')
      process.exit(1)
    })
    req.setTimeout(3000, () => {
      req.destroy()
      console.error('Timed out reaching SlayZone app')
      process.exit(1)
    })
    req.end()
  })

  if (opts.start) {
    const timeoutMs = opts.wait === false ? 0 : parseInt(opts.timeout ?? '5000', 10)
    const r = await apiPost<{ ok: boolean; alreadyAlive?: boolean; sessionId?: string }>(
      '/api/pty/start',
      { taskId: task.id, timeoutMs }
    )
    const startLabel = r.alreadyAlive ? 'already alive' : 'started'
    console.log(
      `${opts.background ? 'Opening (bg)' : 'Opening'} + ${startLabel}: ${task.id.slice(0, 8)}  ${task.title}`
    )
    return
  }
  console.log(
    `${opts.background ? 'Opening (bg)' : 'Opening'}: ${task.id.slice(0, 8)}  ${task.title}`
  )
}
