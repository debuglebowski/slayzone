/**
 * REST: GET+POST /api/tasks/:id/subtasks contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/subtasks.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerTaskSubtasksRoutes } from './subtasks.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')

const parentId = crypto.randomUUID()
h.db
  .prepare(`INSERT INTO tasks (id, project_id, title, terminal_mode, "order") VALUES (?, ?, ?, ?, 1)`)
  .run(parentId, projectId, 'Parent', 'codex')
const kidVisible = crypto.randomUUID()
h.db
  .prepare(`INSERT INTO tasks (id, project_id, parent_id, title, "order") VALUES (?, ?, ?, ?, 2)`)
  .run(kidVisible, projectId, parentId, 'Kid visible')
h.db
  .prepare(
    `INSERT INTO tasks (id, project_id, parent_id, title, "order", archived_at) VALUES (?, ?, ?, ?, 3, '2026-01-01')`
  )
  .run(crypto.randomUUID(), projectId, parentId, 'Kid archived')

let notifyCount = 0
const app = express()
app.use(express.json())
registerTaskSubtasksRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

type SubtasksResponse = { ok: boolean; data: { id: string; title: string }[] }
type CreateResponse = {
  ok: boolean
  data: {
    id: string
    parent_id: string
    project_id: string
    title: string
    status: string
    priority: number
  }
  existing?: boolean
  error?: string
}

await describe('GET /api/tasks/:id/subtasks', () => {
  test('happy: lists visible subtasks only', async () => {
    const res = await rest.request<SubtasksResponse>('GET', `/api/tasks/${parentId}/subtasks`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([kidVisible])
  })

  test('404: unknown parent', async () => {
    const res = await rest.request<SubtasksResponse>('GET', '/api/tasks/ffffffff/subtasks')
    expect(res.status).toBe(404)
  })
})

await describe('POST /api/tasks/:id/subtasks', () => {
  test('happy: creates subtask inheriting project + terminal mode; notifies', async () => {
    notifyCount = 0
    const res = await rest.request<CreateResponse>('POST', `/api/tasks/${parentId}/subtasks`, {
      title: 'New subtask'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.parent_id).toBe(parentId)
    expect(res.body.data.project_id).toBe(projectId)
    expect(res.body.data.title).toBe('New subtask')
    expect(res.body.data.status).toBe('inbox') // default status of default columns
    expect(res.body.data.priority).toBe(3)
    const row = h.db
      .prepare('SELECT terminal_mode, is_temporary FROM tasks WHERE id = ?')
      .get(res.body.data.id) as { terminal_mode: string; is_temporary: number }
    expect(row.terminal_mode).toBe('codex') // inherited from parent
    expect(row.is_temporary).toBe(0)
    expect(notifyCount).toBe(1)
  })

  test('happy: explicit status alias + priority', async () => {
    const res = await rest.request<CreateResponse>('POST', `/api/tasks/${parentId}/subtasks`, {
      title: 'Custom',
      status: 'In Progress',
      priority: 1
    })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('in_progress')
    expect(res.body.data.priority).toBe(1)
  })

  test('external-id dedupe returns existing row', async () => {
    const first = await rest.request<CreateResponse>('POST', `/api/tasks/${parentId}/subtasks`, {
      title: 'Linked',
      externalId: 'EXT-1',
      externalProvider: 'linear'
    })
    expect(first.status).toBe(200)
    const second = await rest.request<CreateResponse>('POST', `/api/tasks/${parentId}/subtasks`, {
      title: 'Linked again',
      externalId: 'EXT-1',
      externalProvider: 'linear'
    })
    expect(second.status).toBe(200)
    expect(second.body.existing).toBe(true)
    expect(second.body.data.id).toBe(first.body.data.id)
  })

  test('400: missing title', async () => {
    const res = await rest.request<CreateResponse>('POST', `/api/tasks/${parentId}/subtasks`, {})
    expect(res.status).toBe(400)
  })

  test('400: priority out of range', async () => {
    const res = await rest.request<CreateResponse>('POST', `/api/tasks/${parentId}/subtasks`, {
      title: 'bad',
      priority: 9
    })
    expect(res.status).toBe(400)
  })

  test('400: unknown status', async () => {
    const res = await rest.request<CreateResponse>('POST', `/api/tasks/${parentId}/subtasks`, {
      title: 'bad status',
      status: 'nope-not-a-status'
    })
    expect(res.status).toBe(400)
  })

  test('404: unknown parent', async () => {
    const res = await rest.request<CreateResponse>('POST', '/api/tasks/ffffffff/subtasks', {
      title: 'orphan'
    })
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
