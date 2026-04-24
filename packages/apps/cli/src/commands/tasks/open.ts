import http from 'node:http'
import { openDb, getMcpPort } from '../../db'
import { resolveId } from './_shared'

export async function openAction(idPrefix: string | undefined): Promise<void> {
  idPrefix = resolveId(idPrefix)
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
  db.close()

  const port = getMcpPort()
  if (!port) {
    console.error('No running SlayZone app found. Start the app first.')
    process.exit(1)
  }

  await new Promise<void>((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: `/api/open-task/${task.id}`, method: 'POST' },
      (res) => { res.resume(); res.on('end', resolve) },
    )
    req.on('error', () => {
      console.error('Failed to reach SlayZone app. Is it running?')
      process.exit(1)
    })
    req.setTimeout(3000, () => { req.destroy(); console.error('Timed out reaching SlayZone app'); process.exit(1) })
    req.end()
  })
  console.log(`Opening: ${task.id.slice(0, 8)}  ${task.title}`)
}
