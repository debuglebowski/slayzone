/**
 * REST: PATCH /api/tasks/:id contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/update.test.ts
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
import { registerUpdateTaskRoute } from './update.js'

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
registerUpdateTaskRoute(app, {
  db: h.slayDb,
  taskBus: ipcMain,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

function seedTask(extra: Record<string, unknown> = {}): string {
  const id = (extra.id as string) ?? crypto.randomUUID()
  const status = (extra.status as string) ?? 'todo'
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, 'T', status, 3, 0)
  return id
}

await describe('PATCH /api/tasks/:id', () => {
  test('happy: 200 updates title; emits dual signals', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:updated')
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: { title: string } }>(
      'PATCH',
      `/api/tasks/${id}`,
      { title: 'Renamed' }
    )
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.title).toBe('Renamed')
    const row = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(id) as { title: string }
    expect(row.title).toBe('Renamed')
    expect(spy.calls.length).toBe(1)
    expect((spy.calls[0].payload as { taskId: string }).taskId).toBe(id)
    const updateEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:update:done')
    expect(updateEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('side-effect: oldStatus carried in payload when status changes', async () => {
    const id = seedTask({ status: 'todo' })
    const spy = spyTaskEvents(taskEvents, 'task:updated')
    await rest.request('PATCH', `/api/tasks/${id}`, { status: 'in_progress' })
    spy.stop()
    expect(spy.calls.length).toBeGreaterThanOrEqual(1)
    const payload = spy.calls[0].payload as { oldStatus?: string }
    expect(payload.oldStatus).toBe('todo')
  })

  test('404: a non-uuid id is just a prefix that matches nothing', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>(
      'PATCH',
      '/api/tasks/not-a-uuid',
      { title: 'x' }
    )
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('Task not found: not-a-uuid')
  })

  test('happy: unique id prefix resolves (CLI addresses tasks by prefix)', async () => {
    const id = seedTask({ id: `11111111-${crypto.randomUUID().slice(9)}` })
    const res = await rest.request<{ ok: boolean; data: { id: string; title: string } }>(
      'PATCH',
      '/api/tasks/11111111',
      { title: 'ByPrefix' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(id)
    expect(res.body.data.title).toBe('ByPrefix')
  })

  test('400: ambiguous prefix lists the candidate ids and writes nothing', async () => {
    const a = seedTask({ id: `22222222-aaaa-${crypto.randomUUID().slice(14)}` })
    const b = seedTask({ id: `22222222-cccc-${crypto.randomUUID().slice(14)}` })
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', '/api/tasks/22222222', {
      title: 'Nope'
    })
    expect(res.status).toBe(400)
    expect(res.body.error.includes('Ambiguous id prefix "22222222"')).toBe(true)
    expect(res.body.error.includes(a.slice(0, 8))).toBe(true)
    expect(res.body.error.includes(b.slice(0, 8))).toBe(true)
    const rows = h.db
      .prepare('SELECT title FROM tasks WHERE id IN (?, ?)')
      .all(a, b) as Array<{ title: string }>
    expect(rows.every((r) => r.title === 'T')).toBe(true)
  })

  test('404: unknown id names what was searched for', async () => {
    const ghost = crypto.randomUUID()
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${ghost}`, {
      title: 'x'
    })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe(`Task not found: ${ghost}`)
  })

  test('status: a label alias resolves to the column id (CLI --status parity)', async () => {
    const id = seedTask()
    const res = await rest.request<{ ok: boolean; data: { status: string } }>(
      'PATCH',
      `/api/tasks/${id}`,
      { status: 'In Progress' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('in_progress')
  })

  test('400: an unresolvable status is rejected, not coerced to the default', async () => {
    const id = seedTask({ status: 'todo' })
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${id}`, {
      status: 'nonsense-status'
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(`Unknown status "nonsense-status" for this task's project.`)
    const row = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('todo')
  })

  test('parentId: a unique prefix resolves to the full parent id', async () => {
    const parent = seedTask({ id: `33333333-${crypto.randomUUID().slice(9)}` })
    const child = seedTask()
    const res = await rest.request<{ ok: boolean; data: { parent_id: string } }>(
      'PATCH',
      `/api/tasks/${child}`,
      { parentId: '33333333' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.parent_id).toBe(parent)
  })

  test('404: unknown parent prefix names the parent (CLI --parent wording)', async () => {
    const child = seedTask()
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${child}`, {
      parentId: 'no-such-parent'
    })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Parent task not found: no-such-parent')
  })

  test('400: ambiguous parent prefix says "parent id prefix" so the operator knows which arg', async () => {
    const p1 = seedTask({ id: `44444444-aaaa-${crypto.randomUUID().slice(14)}` })
    const p2 = seedTask({ id: `44444444-cccc-${crypto.randomUUID().slice(14)}` })
    const child = seedTask()
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${child}`, {
      parentId: '44444444'
    })
    expect(res.status).toBe(400)
    expect(res.body.error.includes('Ambiguous parent id prefix "44444444"')).toBe(true)
    expect(res.body.error.includes(p1.slice(0, 8))).toBe(true)
    expect(res.body.error.includes(p2.slice(0, 8))).toBe(true)
  })

  test('parentId: null still detaches (never treated as a prefix)', async () => {
    const parent = seedTask()
    const child = seedTask()
    await rest.request('PATCH', `/api/tasks/${child}`, { parentId: parent })
    const res = await rest.request<{ ok: boolean; data: { parent_id: string | null } }>(
      'PATCH',
      `/api/tasks/${child}`,
      { parentId: null }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.parent_id).toBeNull()
  })

  test('appendDescription: appends to the stored description on a newline', async () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run('first line', id)
    const res = await rest.request<{ ok: boolean; data: { description: string } }>(
      'PATCH',
      `/api/tasks/${id}`,
      { appendDescription: 'second line' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.description).toBe('first line\nsecond line')
  })

  test('appendDescription: a null description appends onto an empty string', async () => {
    const id = seedTask()
    const res = await rest.request<{ ok: boolean; data: { description: string } }>(
      'PATCH',
      `/api/tasks/${id}`,
      { appendDescription: 'only line' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.description).toBe('\nonly line')
  })

  test('400: appendDescription together with description is rejected', async () => {
    const id = seedTask()
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${id}`, {
      description: 'a',
      appendDescription: 'b'
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Cannot use both --description and --append-description.')
  })

  test('400: priority out of range', async () => {
    const id = seedTask()
    const res = await rest.request('PATCH', `/api/tasks/${id}`, { priority: 99 })
    expect(res.status).toBe(400)
  })

  test('400: unknown field rejected (strict schema)', async () => {
    const id = seedTask()
    const res = await rest.request('PATCH', `/api/tasks/${id}`, { wat: 'unknown' })
    expect(res.status).toBe(400)
  })

  test('404: update non-existent task', async () => {
    const ghost = crypto.randomUUID()
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${ghost}`, {
      title: 'x'
    })
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
  })

  test('500: invalid reparent throws (cyclic)', async () => {
    const id = seedTask()
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${id}`, {
      parentId: id
    })
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
  })
})

await rest.close()
h.cleanup()
