/**
 * REST: POST /api/open-task/:id contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/tasks/open.test.ts
 */
import express from 'express'
import { describe, test, expect, afterAll } from 'vitest'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { registerOpenTaskRoute } from './open.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p')
const insertTask = h.db.prepare(
  'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
)
function seedTask(id: string): string {
  insertTask.run(id, projectId, 'T', 'todo', 3, 0)
  return id
}
// `abc-123` / `xyz-789` are the ids the pre-existing cases below address; they
// must EXIST now that the route resolves `:id` against the tasks table.
seedTask('abc-123')
seedTask('xyz-789')

// The route reaches the renderer through INJECTED deps: the `open-task` menu event
// (which the renderer that opens the tab acts on, raising its window when `raise`)
// and the legacy broadcast. It never raises a window itself — the hub it runs on may
// be a remote one with no window to reach.
const sent: Array<{ channel: string; args: unknown[] }> = []
const events: Array<{ taskId: string; background?: boolean; raise?: boolean }> = []

function reset(): void {
  sent.length = 0
  events.length = 0
}

const app = express()
app.use(express.json())
registerOpenTaskRoute(app, {
  db: h.slayDb,
  notifyRenderer: () => {},
  legacyBroadcast: (channel: string, ...args: unknown[]) => {
    sent.push({ channel, args })
  },
  menu: {
    emit: (event: string, payload: (typeof events)[number]) => {
      if (event === 'open-task') events.push(payload)
    }
  }
} as never)
const rest = await mountRestApp(app)

describe('POST /api/open-task/:id', () => {
  test('foreground (no flag): broadcasts (id, false) + asks the renderer to raise', async () => {
    reset()
    const res = await rest.request<{ ok: boolean }>('POST', '/api/open-task/abc-123')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const ev = sent.find((s) => s.channel === 'app:open-task')
    expect(ev).toBeTruthy()
    expect(ev!.args[0]).toBe('abc-123')
    expect(ev!.args[1]).toBe(false)
    expect(events).toEqual([{ taskId: 'abc-123', background: false, raise: true }])
  })

  test('background=1: broadcasts (id, true) + does NOT ask to raise', async () => {
    reset()
    const res = await rest.request<{ ok: boolean }>('POST', '/api/open-task/xyz-789?background=1')
    expect(res.status).toBe(200)
    const ev = sent.find((s) => s.channel === 'app:open-task')
    expect(ev).toBeTruthy()
    expect(ev!.args[0]).toBe('xyz-789')
    expect(ev!.args[1]).toBe(true)
    expect(events).toEqual([{ taskId: 'xyz-789', background: true, raise: false }])
  })

  test('background=true (string): also treated as background', async () => {
    reset()
    await rest.request<{ ok: boolean }>('POST', '/api/open-task/xyz-789?background=true')
    const ev = sent.find((s) => s.channel === 'app:open-task')
    expect(ev!.args[1]).toBe(true)
    expect(events[0].raise).toBe(false)
  })

  test('background=0: treated as foreground', async () => {
    reset()
    await rest.request<{ ok: boolean }>('POST', '/api/open-task/abc-123?background=0')
    const ev = sent.find((s) => s.channel === 'app:open-task')
    expect(ev!.args[1]).toBe(false)
    expect(events[0].raise).toBe(true)
  })

  test('happy: unique id prefix broadcasts the FULL resolved id', async () => {
    reset()
    const id = seedTask(`55555555-${crypto.randomUUID().slice(9)}`)
    const res = await rest.request<{ ok: boolean; data: { id: string; title: string } }>(
      'POST',
      '/api/open-task/55555555'
    )
    expect(res.status).toBe(200)
    // The CLI echoes the resolved id + title, so the route must return them.
    expect(res.body.data.id).toBe(id)
    expect(res.body.data.title).toBe('T')
    const ev = sent.find((s) => s.channel === 'app:open-task')
    expect(ev!.args[0]).toBe(id)
  })

  test('400: ambiguous prefix lists candidates and broadcasts nothing', async () => {
    reset()
    const a = seedTask(`66666666-aaaa-${crypto.randomUUID().slice(14)}`)
    const b = seedTask(`66666666-cccc-${crypto.randomUUID().slice(14)}`)
    const res = await rest.request<{ ok: boolean; error: string }>(
      'POST',
      '/api/open-task/66666666'
    )
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.includes('Ambiguous id prefix "66666666"')).toBe(true)
    expect(res.body.error.includes(a.slice(0, 8))).toBe(true)
    expect(res.body.error.includes(b.slice(0, 8))).toBe(true)
    expect(sent.length).toBe(0)
    expect(events.length).toBe(0)
  })

  test('404: unknown id names what was searched for and broadcasts nothing', async () => {
    reset()
    const res = await rest.request<{ ok: boolean; error: string }>(
      'POST',
      '/api/open-task/no-such-task'
    )
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Task not found: no-such-task')
    expect(sent.length).toBe(0)
    expect(events.length).toBe(0)
  })
})

afterAll(async () => {
  await rest.close()
  h.cleanup()
})
