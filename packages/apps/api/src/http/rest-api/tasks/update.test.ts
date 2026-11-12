/**
 * REST: PATCH /api/tasks/:id contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/tasks/update.test.ts
 */
import express from 'express'
import { describe, test, expect, afterAll } from 'vitest'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../../../../shared/test-utils/event-spy.js'
import {
  ipcMain,
  __ipcEmitCalls,
  __resetIpcEmitCalls
} from '../../../../../../shared/test-utils/mock-electron.js'
import {
  taskEvents,
  configureTaskRuntimeAdapters,
  getTaskPathsDelegate,
  setTaskPathsDelegate,
  setTaskSessionLedger
} from '@slayzone/task/server'
import { COMPUTER_REFUSED_RPC_CODE } from '@slayzone/platform/path-scope'
import { createSessionLedgerHarness } from '@slayzone/chat-runtime/server'
import { tmpdir } from 'node:os'
import { TypedEmitter } from '@slayzone/platform/events'
import { setChatDeps, setPtyDeps, type ChatDeps, type PtyDeps } from '@slayzone/terminal/server'
import { registerUpdateTaskRoute } from './update.js'

const h = await createTestHarness()
// archive/cleanup ops resolve the data root via the task runtime adapter.
configureTaskRuntimeAdapters({ getDataRoot: () => tmpdir() })
// The session ledger lives on the task's computer (robustness plan §9).
const computer = createSessionLedgerHarness({ db: h.slayDb })
setTaskSessionLedger(computer.ledger)
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
/** Session ids the stub reports mid-reply, per task. */
const midReply = new Map<string, string[]>()
const app = express()
app.use(express.json())
registerUpdateTaskRoute(app, {
  db: h.slayDb,
  taskBus: ipcMain,
  notifyRenderer: () => {
    notifyCount++
  },
  taskAgents: { midReplySessionIds: async (taskId) => midReply.get(taskId) ?? [] }
})
const rest = await mountRestApp(app)

// The agent runtime, faked: which main agents a mode switch stopped.
let killed: string[] = []
setPtyDeps({
  ops: {
    agentsList: async () => [
      { id: 'claude-code', enabled: true },
      { id: 'codex', enabled: true },
      { id: 'gemini', enabled: false }
    ],
    ptyKill: (sid: string) => {
      killed.push(`pty:${sid}`)
      return true
    }
  } as unknown as PtyDeps['ops'],
  events: new TypedEmitter()
} as PtyDeps)
setChatDeps({
  ops: { kill: (tabId: string) => void killed.push(`chat:${tabId}`) },
  queueOps: {},
  events: new TypedEmitter(),
  queueEvents: new TypedEmitter()
} as unknown as ChatDeps)

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

describe('PATCH /api/tasks/:id', () => {
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
    const rows = h.db.prepare('SELECT title FROM tasks WHERE id IN (?, ?)').all(a, b) as Array<{
      title: string
    }>
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

  test('projectId + status: the status resolves against the TARGET project', async () => {
    const targetId = crypto.randomUUID()
    h.db
      .prepare(
        'INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        targetId,
        'RestMoveTarget',
        '#111',
        '/tmp/rest-move-target',
        JSON.stringify([
          { id: 'backlog', label: 'Backlog', color: 'gray', position: 0, category: 'unstarted' },
          { id: 'shipping', label: 'Shipping', color: 'blue', position: 1, category: 'started' },
          { id: 'shipped', label: 'Shipped', color: 'green', position: 2, category: 'completed' }
        ])
      )
    const id = seedTask({ status: 'todo' })
    const res = await rest.request<{ ok: boolean; data: { project_id: string; status: string } }>(
      'PATCH',
      `/api/tasks/${id}`,
      { projectId: targetId, status: 'Shipping' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ project_id: targetId, status: 'shipping' })
  })

  test('409: a terminal status while an agent is mid-reply is refused, nothing written; force completes', async () => {
    const id = seedTask()
    midReply.set(id, [`${id}:${id}`])
    try {
      for (const status of ['done', 'canceled']) {
        const res = await rest.request<{ ok: boolean; code: string; error: string }>(
          'PATCH',
          `/api/tasks/${id}`,
          { status, title: 'renamed' }
        )
        expect(res.status).toBe(409)
        expect(res.body.code).toBe('agent_mid_reply')
        expect(res.body.error).toContain('--force')
      }
      expect(h.db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(id)).toEqual({
        status: 'todo',
        title: 'T'
      })
      const forced = await rest.request<{ ok: boolean; data: { status: string } }>(
        'PATCH',
        `/api/tasks/${id}`,
        { status: 'done', force: true }
      )
      expect(forced.status).toBe(200)
      expect(forced.body.data.status).toBe('done')
    } finally {
      midReply.delete(id)
    }
  })

  test('a non-terminal status (or no status) is never blocked by a mid-reply agent', async () => {
    const id = seedTask()
    midReply.set(id, [`${id}:${id}`])
    try {
      const res = await rest.request<{ ok: boolean; data: { status: string } }>(
        'PATCH',
        `/api/tasks/${id}`,
        { status: 'in_progress', title: 'still working' }
      )
      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('in_progress')
    } finally {
      midReply.delete(id)
    }
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

  test('agentId: a mode switch — stops the main agent, clears conversations', async () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET agent_id = ? WHERE id = ?').run('claude-code', id)
    await computer.service.handle({
      op: 'recordConversation',
      args: { taskId: id, mode: 'claude-code', conversationId: 'c1', origin: 'slay-spawned-resume' }
    })
    killed = []
    const res = await rest.request<{ ok: boolean; data: { agent_id: string; title: string } }>(
      'PATCH',
      `/api/tasks/${id.slice(0, 8)}`,
      { agentId: 'codex', title: 'Both' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ agent_id: 'codex', title: 'Both' })
    expect(killed).toEqual([`pty:${id}:${id}`])
    expect(
      await computer.ledger.store.getCurrentConversationId(computer.computerId, id, 'claude-code')
    ).toBeNull()
  })

  test('terminalMode: deprecated alias of agentId still switches the agent', async () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET agent_id = ? WHERE id = ?').run('claude-code', id)
    killed = []
    const res = await rest.request<{ ok: boolean; data: { agent_id: string } }>(
      'PATCH',
      `/api/tasks/${id}`,
      { terminalMode: 'codex' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.agent_id).toBe('codex')
    expect(killed).toEqual([`pty:${id}:${id}`])
  })

  test('agentId + terminalMode: same value is fine, different values are a 400', async () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET agent_id = ? WHERE id = ?').run('claude-code', id)
    killed = []
    const bad = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${id}`, {
      agentId: 'codex',
      terminalMode: 'claude-code'
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/agentId.*terminalMode/)
    expect(killed).toEqual([])
    const same = await rest.request<{ ok: boolean; data: { agent_id: string } }>(
      'PATCH',
      `/api/tasks/${id}`,
      { agentId: 'codex', terminalMode: 'codex' }
    )
    expect(same.status).toBe(200)
    expect(same.body.data.agent_id).toBe('codex')
  })

  test('400: unknown or disabled agentId names the enabled ones; nothing stopped', async () => {
    const id = seedTask()
    killed = []
    for (const [mode, word] of [
      ['nope', 'Unknown'],
      ['gemini', 'Disabled']
    ]) {
      const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${id}`, {
        agentId: mode
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(`${word} agent "${mode}". Enabled: claude-code, codex`)
    }
    expect(killed).toEqual([])
  })

  test('400: an invalid field next to agentId stops nothing', async () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET agent_id = ? WHERE id = ?').run('claude-code', id)
    killed = []
    const res = await rest.request('PATCH', `/api/tasks/${id}`, {
      agentId: 'codex',
      priority: 9
    })
    expect(res.status).toBe(400)
    expect(killed).toEqual([])
  })

  test('409: a path set while no computer holds the task folders is refused, nothing written', async () => {
    // The hub keeps no path (§9 7e): with no computer to hold it, setting one is a
    // precondition the caller can fix (connect a computer), never a server error.
    const id = seedTask()
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${id}`, {
      worktreePath: '/tmp/p-wt'
    })
    expect(res.status).toBe(409)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/computer/i)
    const row = h.db.prepare('SELECT has_worktree FROM tasks WHERE id = ?').get(id) as {
      has_worktree: number
    }
    expect(row.has_worktree).toBe(0)
  })

  test('409 COMPUTER_REFUSED: the task computer refuses the folder, nothing written (B3)', async () => {
    // The computer's path jail refused it (an RpcError with refusedByComputer, as the
    // hub gateway rejects): a conflict the caller can resolve, never a 500.
    const id = seedTask()
    const refused = Object.assign(
      new Error("path '/etc' is outside this computer's allowed folders; refused"),
      { name: 'RpcError', code: COMPUTER_REFUSED_RPC_CODE }
    )
    const prior = getTaskPathsDelegate()
    setTaskPathsDelegate({
      changed: async () => {},
      release: async () => ({ worktreePath: null, shared: false, computerId: 'c' }),
      apply: async () => {
        throw refused
      },
      forget: async () => {},
      read: async () => ({})
    } as never)
    try {
      const res = await rest.request<{ ok: boolean; error: string; code: string }>(
        'PATCH',
        `/api/tasks/${id}`,
        { baseDir: '/etc' }
      )
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ ok: false, code: 'COMPUTER_REFUSED' })
      expect(res.body.error).toMatch(/outside this computer's allowed folders/)
      const row = h.db.prepare('SELECT has_base_dir FROM tasks WHERE id = ?').get(id) as {
        has_base_dir: number
      }
      expect(row.has_base_dir).toBe(0)
    } finally {
      setTaskPathsDelegate(prior)
    }
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

afterAll(async () => {
  await rest.close()
  h.cleanup()
  computer.close()
})
