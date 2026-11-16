/**
 * REST: POST /api/tasks/:id/reset-conversation contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/tasks/reset-conversation.test.ts
 */
import express from 'express'
import { describe, test, expect, afterAll } from 'vitest'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { createSessionLedgerHarness } from '@slayzone/chat-runtime/server'
import { setTaskSessionLedger } from '@slayzone/task/server'
import { registerTaskResetConversationRoute } from './reset-conversation.js'

const h = await createTestHarness()
// The session ledger lives on the task's computer (robustness plan §9): an
// in-process one. A reset is the hub's intent, delivered to it.
const computer = createSessionLedgerHarness({ db: h.slayDb })
setTaskSessionLedger(computer.ledger)
const seed = (taskId: string, mode: string, conversationId: string, tabId?: string) =>
  computer.service.handle({
    op: 'recordConversation',
    args: {
      taskId,
      mode,
      conversationId,
      origin: 'slay-spawned-resume',
      ...(tabId ? { tabId } : {})
    }
  })

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const withConvs = crypto.randomUUID()
const withoutConvs = crypto.randomUUID()
const insertTask = h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
insertTask.run(withConvs, projectId, 'Has conversations')
insertTask.run(withoutConvs, projectId, 'No conversations')

await seed(withConvs, 'claude-code', crypto.randomUUID())
await seed(withConvs, 'codex', crypto.randomUUID())

const app = express()
app.use(express.json())
registerTaskResetConversationRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

type ResetResponse = { ok: boolean; data: { id: string; reset: string[] }; error?: string }

describe('POST /api/tasks/:id/reset-conversation', () => {
  test('happy: resets every mode with sessions; the computer applies the reset', async () => {
    const res = await rest.request<ResetResponse>(
      'POST',
      `/api/tasks/${withConvs}/reset-conversation`,
      {}
    )
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(withConvs)
    expect([...res.body.data.reset].sort()).toEqual(['claude-code', 'codex'])
    for (const mode of ['claude-code', 'codex'])
      expect(
        await computer.ledger.store.getCurrentConversationId(computer.computerId, withConvs, mode),
        mode
      ).toBeNull()
  })

  test('computer offline: the reset is kept for it and reported as every mode', async () => {
    const t = crypto.randomUUID()
    insertTask.run(t, projectId, 'Offline')
    await seed(t, 'claude-code', 'offline-conv')
    computer.setOnline(false)
    try {
      const res = await rest.request<ResetResponse>(
        'POST',
        `/api/tasks/${t}/reset-conversation`,
        {}
      )
      expect(res.status).toBe(200)
      expect(res.body.data.reset).toEqual(['*'])
    } finally {
      computer.setOnline(true)
    }
    await computer.ledger.onComputerConnected(computer.computerId)
    expect(
      await computer.ledger.store.getCurrentConversationId(computer.computerId, t, 'claude-code')
    ).toBeNull()
  })

  test('happy: explicit mode resets only that mode', async () => {
    await seed(withConvs, 'claude-code', 'keep-code')
    await seed(withConvs, 'codex', 'drop-codex')
    const res = await rest.request<ResetResponse>(
      'POST',
      `/api/tasks/${withConvs}/reset-conversation`,
      { mode: 'codex' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.reset).toEqual(['codex'])
    const current = (mode: string) =>
      computer.ledger.store.getCurrentConversationId(computer.computerId, withConvs, mode)
    expect(await current('codex')).toBeNull()
    expect(await current('claude-code')).toBe('keep-code')
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

describe('per-tab scope (sessions are per terminal tab, v201)', () => {
  const tabbed = crypto.randomUUID()
  insertTask.run(tabbed, projectId, 'Two tabs')
  h.db
    .prepare(
      `INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
       VALUES (?, ?, NULL, 'claude-code', 1, 0, ?, '2026-01-01'),
              ('deploy-tab-1', ?, 'deploy', 'claude-code', 0, 1, 'deploy-tab-1', '2026-01-01'),
              ('deploy-tab-2', ?, 'deploy2', 'claude-code', 0, 2, 'deploy-tab-2', '2026-01-01')`
    )
    .run(tabbed, tabbed, tabbed, tabbed, tabbed)
  const seeded = Promise.all([
    seed(tabbed, 'claude-code', 'main-conv', tabbed),
    seed(tabbed, 'claude-code', 'deploy-conv', 'deploy-tab-1')
  ])
  const resetTabs = () =>
    (
      h.db
        .prepare('SELECT tab_id FROM session_resets WHERE task_id = ? ORDER BY rowid')
        .all(tabbed) as {
        tab_id: string | null
      }[]
    ).map((r) => r.tab_id)

  test('default: the main tab only', async () => {
    await seeded
    const res = await rest.request<ResetResponse & { data: { tab: string } }>(
      'POST',
      `/api/tasks/${tabbed}/reset-conversation`,
      {}
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ tab: tabbed, reset: ['claude-code'] })
    expect(resetTabs()).toEqual([tabbed])
  })

  test('tab by label resets that tab only', async () => {
    const res = await rest.request<ResetResponse & { data: { tab: string } }>(
      'POST',
      `/api/tasks/${tabbed}/reset-conversation`,
      { tab: 'deploy' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ tab: 'deploy-tab-1', reset: ['claude-code'] })
    expect(resetTabs().at(-1)).toBe('deploy-tab-1')
  })

  test('allTabs: one whole-task reset row (no tab)', async () => {
    const res = await rest.request<ResetResponse & { data: { tab: string } }>(
      'POST',
      `/api/tasks/${tabbed}/reset-conversation`,
      { allTabs: true }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.tab).toBe('all')
    expect(resetTabs().at(-1)).toBeNull()
  })

  test('400: unknown or ambiguous tab, or tab + allTabs', async () => {
    for (const body of [{ tab: 'nope' }, { tab: 'deploy-tab' }, { tab: 'deploy', allTabs: true }]) {
      const res = await rest.request<ResetResponse>(
        'POST',
        `/api/tasks/${tabbed}/reset-conversation`,
        body
      )
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })
})

afterAll(async () => {
  await rest.close()
  h.cleanup()
  computer.close()
})
