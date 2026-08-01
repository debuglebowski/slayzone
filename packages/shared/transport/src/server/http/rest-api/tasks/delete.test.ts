/**
 * REST: DELETE /api/tasks/:id contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/delete.test.ts
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
import { registerDeleteTaskRoute } from './delete.js'

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
registerDeleteTaskRoute(app, {
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

await describe('DELETE /api/tasks/:id', () => {
  test('happy: 200 + soft-deletes (deleted_at set) + taskEvents emits', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:deleted')
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: boolean }>('DELETE', `/api/tasks/${id}`)
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toBe(true)
    const row = h.db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as {
      deleted_at: string | null
    }
    expect(row.deleted_at !== null).toBe(true)
    expect(spy.calls.length).toBe(1)
    expect((spy.calls[0].payload as { taskId: string }).taskId).toBe(id)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('emits db:tasks:delete:done (dual-emit invariant)', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    await rest.request('DELETE', `/api/tasks/${id}`)
    const deleteEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:delete:done')
    expect(deleteEmits.length).toBeGreaterThanOrEqual(1)
    expect(deleteEmits[0][2]).toBe(id)
  })

  test('happy: unique id prefix resolves (CLI addresses tasks by prefix)', async () => {
    const id = seedTask(`eeeeeeee-${crypto.randomUUID().slice(9)}`)
    const res = await rest.request<{
      ok: boolean
      data: boolean
      task: { id: string; title: string }
    }>('DELETE', '/api/tasks/eeeeeeee')
    expect(res.status).toBe(200)
    // `data` keeps its boolean|{blocked} contract; the resolved task rides
    // alongside it, because the CLI echoes id + title and no longer reads the DB.
    expect(res.body.data).toBe(true)
    expect(res.body.task.id).toBe(id)
    expect(res.body.task.title).toBe('T')
    const row = h.db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as {
      deleted_at: string | null
    }
    expect(row.deleted_at !== null).toBe(true)
  })

  test('blocked: the resolved task rides along so the CLI can still name it', async () => {
    const id = seedTask()
    const connId = crypto.randomUUID()
    h.db
      .prepare(
        `INSERT INTO integration_connections (id, provider, credential_ref) VALUES (?, 'github', 'ref')`
      )
      .run(connId)
    h.db
      .prepare(
        `INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, task_id) VALUES (?, 'github', ?, 'issue', '99', '99', ?)`
      )
      .run(crypto.randomUUID(), connId, id)
    const res = await rest.request<{
      ok: boolean
      data: { blocked: true }
      task: { id: string }
    }>('DELETE', `/api/tasks/${id}`)
    expect(res.status).toBe(200)
    expect(res.body.data.blocked).toBe(true)
    expect(res.body.task.id).toBe(id)
  })

  test('400: ambiguous prefix lists the candidate ids and deletes nothing', async () => {
    const a = seedTask(`ffffffff-aaaa-${crypto.randomUUID().slice(14)}`)
    const b = seedTask(`ffffffff-cccc-${crypto.randomUUID().slice(14)}`)
    const res = await rest.request<{ ok: boolean; error: string }>('DELETE', '/api/tasks/ffffffff')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.includes('Ambiguous id prefix "ffffffff"')).toBe(true)
    expect(res.body.error.includes(a.slice(0, 8))).toBe(true)
    expect(res.body.error.includes(b.slice(0, 8))).toBe(true)
    const rows = h.db
      .prepare('SELECT deleted_at FROM tasks WHERE id IN (?, ?)')
      .all(a, b) as Array<{ deleted_at: string | null }>
    expect(rows.every((r) => r.deleted_at === null)).toBe(true)
  })

  test('404: unknown id names what was searched for', async () => {
    const ghost = crypto.randomUUID()
    const res = await rest.request<{ ok: boolean; error: string }>('DELETE', `/api/tasks/${ghost}`)
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe(`Task not found: ${ghost}`)
  })

  test('404: a non-uuid id is just a prefix that matches nothing', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>(
      'DELETE',
      '/api/tasks/not-a-uuid'
    )
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('Task not found: not-a-uuid')
  })

  test('blocked: returns linked_to_provider + does NOT emit', async () => {
    const id = seedTask()
    const connId = crypto.randomUUID()
    h.db
      .prepare(
        `INSERT INTO integration_connections (id, provider, credential_ref) VALUES (?, 'github', 'ref')`
      )
      .run(connId)
    h.db
      .prepare(
        `INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, task_id) VALUES (?, 'github', ?, 'issue', '42', '42', ?)`
      )
      .run(crypto.randomUUID(), connId, id)
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:deleted')
    const res = await rest.request<{ ok: boolean; data: { blocked: true; reason: string } }>(
      'DELETE',
      `/api/tasks/${id}`
    )
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect((res.body.data as { blocked: boolean }).blocked).toBe(true)
    expect((res.body.data as { reason: string }).reason).toBe('linked_to_provider')
    const row = h.db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as {
      deleted_at: string | null
    }
    expect(row.deleted_at).toBeNull()
    expect(spy.calls.length).toBe(0)
  })
})

await rest.close()
h.cleanup()
