/**
 * REST: POST /api/tasks/:id/archive contract tests.
 * Run with: pnpm tsx --loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/archive.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../../../../test-utils/event-spy.js'
import {
  ipcMain,
  __ipcEmitCalls,
  __resetIpcEmitCalls
} from '../../../../../../test-utils/mock-electron.js'
import { taskEvents, configureTaskRuntimeAdapters } from '@slayzone/task/server'
import { tmpdir } from 'node:os'
import { registerArchiveTaskRoute } from './archive.js'

const h = await createTestHarness()
// archive/cleanup ops resolve the data root via the task runtime adapter.
configureTaskRuntimeAdapters({ getDataRoot: () => tmpdir() })
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const app = express()
app.use(express.json())
registerArchiveTaskRoute(app, {
  db: h.slayDb,
  taskBus: ipcMain,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

function seedTask(id = crypto.randomUUID()): string {
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

await describe('POST /api/tasks/:id/archive', () => {
  test('happy: 200 + archived payload + DB archived_at set', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    notifyCount = 0
    const res = await rest.request<{
      ok: boolean
      data: { id: string; archived_at: string | null }
    }>('POST', `/api/tasks/${id}/archive`)
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.id).toBe(id)
    expect(res.body.data.archived_at !== null).toBe(true)
    const row = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as {
      archived_at: string | null
    }
    expect(row.archived_at !== null).toBe(true)
    expect(spy.calls.length).toBe(1)
    expect(spy.calls[0].event).toBe('task:archived')
    expect((spy.calls[0].payload as { taskId: string }).taskId).toBe(id)
    const archiveEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:archive:done')
    expect(archiveEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('happy: unique id prefix resolves (CLI addresses tasks by prefix)', async () => {
    const id = seedTask(`aaaaaaaa-${crypto.randomUUID().slice(9)}`)
    const res = await rest.request<{ ok: boolean; data: { id: string } }>(
      'POST',
      '/api/tasks/aaaaaaaa/archive'
    )
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(id)
    const row = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as {
      archived_at: string | null
    }
    expect(row.archived_at !== null).toBe(true)
  })

  test('400: ambiguous prefix lists the candidate ids', async () => {
    const a = seedTask(`bbbbbbbb-aaaa-${crypto.randomUUID().slice(14)}`)
    const b = seedTask(`bbbbbbbb-cccc-${crypto.randomUUID().slice(14)}`)
    const res = await rest.request<{ ok: boolean; error: string }>(
      'POST',
      '/api/tasks/bbbbbbbb/archive'
    )
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.includes('Ambiguous id prefix "bbbbbbbb"')).toBe(true)
    expect(res.body.error.includes(a.slice(0, 8))).toBe(true)
    expect(res.body.error.includes(b.slice(0, 8))).toBe(true)
    // Neither candidate was touched.
    const rows = h.db
      .prepare('SELECT archived_at FROM tasks WHERE id IN (?, ?)')
      .all(a, b) as Array<{ archived_at: string | null }>
    expect(rows.every((r) => r.archived_at === null)).toBe(true)
  })

  test('404: unknown id names what was searched for', async () => {
    const ghost = crypto.randomUUID()
    const res = await rest.request<{ ok: boolean; error: string }>(
      'POST',
      `/api/tasks/${ghost}/archive`
    )
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe(`Task not found: ${ghost}`)
  })

  test('404: a non-uuid id is just a prefix that matches nothing', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>(
      'POST',
      '/api/tasks/not-a-uuid/archive'
    )
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('Task not found: not-a-uuid')
  })

  test('404: an already-archived task is not addressable (CLI archived_at IS NULL filter)', async () => {
    const id = seedTask(`dddddddd-${crypto.randomUUID().slice(9)}`)
    const first = await rest.request('POST', `/api/tasks/${id}/archive`)
    expect(first.status).toBe(200)
    const second = await rest.request<{ ok: boolean; error: string }>(
      'POST',
      '/api/tasks/dddddddd/archive'
    )
    expect(second.status).toBe(404)
    expect(second.body.error).toBe('Task not found: dddddddd')
  })

  test('side-effect: dual-emit invariant for archive (taskEvents + ipcMain)', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    await rest.request('POST', `/api/tasks/${id}/archive`)
    spy.stop()
    expect(spy.calls.length).toBe(1)
    const archiveEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:archive:done')
    expect(archiveEmits.length).toBeGreaterThanOrEqual(1)
  })
})

await rest.close()
h.cleanup()
