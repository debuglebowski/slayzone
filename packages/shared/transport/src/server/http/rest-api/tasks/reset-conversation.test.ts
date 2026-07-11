/**
 * REST: POST /api/tasks/:id/reset-conversation contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/reset-conversation.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerTaskResetConversationRoute } from './reset-conversation.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const withConvs = crypto.randomUUID()
const withoutConvs = crypto.randomUUID()
const insertTask = h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
insertTask.run(withConvs, projectId, 'Has conversations')
insertTask.run(withoutConvs, projectId, 'No conversations')

const insertConv = h.db.prepare(
  `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
   VALUES (?, ?, ?, ?, 'slay-spawned-fresh', NULL, ?)`
)
insertConv.run(crypto.randomUUID(), withConvs, 'claude-code', crypto.randomUUID(), Date.now())
insertConv.run(crypto.randomUUID(), withConvs, 'codex', crypto.randomUUID(), Date.now())

const app = express()
app.use(express.json())
registerTaskResetConversationRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

type ResetResponse = { ok: boolean; data: { id: string; reset: string[] }; error?: string }

await describe('POST /api/tasks/:id/reset-conversation', () => {
  test('happy: resets every mode with rows; sentinel + session_resets appended', async () => {
    const res = await rest.request<ResetResponse>(
      'POST',
      `/api/tasks/${withConvs}/reset-conversation`,
      {}
    )
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(withConvs)
    expect([...res.body.data.reset].sort()).toEqual(['claude-code', 'codex'])
    const sentinels = h.db
      .prepare(
        `SELECT mode, conversation_id FROM task_conversations WHERE task_id = ? AND origin = 'manual-reset'`
      )
      .all(withConvs) as { mode: string; conversation_id: string | null }[]
    expect(sentinels.map((s) => s.mode).sort()).toEqual(['claude-code', 'codex'])
    expect(sentinels.every((s) => s.conversation_id === null)).toBe(true)
    const resets = h.db
      .prepare('SELECT mode FROM session_resets WHERE task_id = ?')
      .all(withConvs) as { mode: string }[]
    expect(resets.map((r) => r.mode).sort()).toEqual(['claude-code', 'codex'])
  })

  test('happy: explicit mode resets only that mode', async () => {
    const before = h.db
      .prepare(`SELECT COUNT(*) AS n FROM session_resets WHERE task_id = ? AND mode = 'codex'`)
      .get(withConvs) as { n: number }
    const res = await rest.request<ResetResponse>(
      'POST',
      `/api/tasks/${withConvs}/reset-conversation`,
      { mode: 'codex' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.reset).toEqual(['codex'])
    const after = h.db
      .prepare(`SELECT COUNT(*) AS n FROM session_resets WHERE task_id = ? AND mode = 'codex'`)
      .get(withConvs) as { n: number }
    expect(after.n).toBe(before.n + 1)
  })

  test('happy: no conversation rows → reset: []', async () => {
    const res = await rest.request<ResetResponse>(
      'POST',
      `/api/tasks/${withoutConvs}/reset-conversation`,
      {}
    )
    expect(res.status).toBe(200)
    expect(res.body.data.reset).toEqual([])
  })

  test('400: non-string mode', async () => {
    const res = await rest.request<ResetResponse>(
      'POST',
      `/api/tasks/${withConvs}/reset-conversation`,
      { mode: 42 }
    )
    expect(res.status).toBe(400)
  })

  test('404: unknown task', async () => {
    const res = await rest.request<ResetResponse>(
      'POST',
      '/api/tasks/ffffffff/reset-conversation',
      {}
    )
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
