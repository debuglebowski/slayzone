/**
 * REST: POST /api/tasks/:id/done contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/tasks/done.test.ts
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
import { taskEvents, configureTaskRuntimeAdapters } from '@slayzone/task/server'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { onTaskReachedTerminal, setTaskAgentsStopper } from '@slayzone/terminal/server'
import { registerDoneTaskRoute } from './done.js'

const h = await createTestHarness()
configureTaskRuntimeAdapters({ getDataRoot: () => tmpdir() })

// Default-columns project: its completed column is the stock `done`.
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p')

// Custom-columns project: its completed column is `closed`, and there is NO
// column whose id/label/slug is "done". This is the case that proves the done
// route cannot be replaced by PATCH's status-ALIAS resolution — `resolveStatusId('done', …)`
// returns null here, while the done INTENT still has an unambiguous answer.
const customProjectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
  .run(
    customProjectId,
    'CUSTOM',
    '#000',
    '/tmp/c',
    JSON.stringify([
      { id: 'queue', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
      { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' },
      { id: 'wontfix', label: 'Wontfix', color: 'slate', position: 3, category: 'canceled' }
    ])
  )

let notifyCount = 0
/** Session ids the stub reports mid-reply, per task. */
const midReply = new Map<string, string[]>()
const closeEmits: string[] = []
const legacySends: Array<{ channel: string; args: unknown[] }> = []

const app = express()
app.use(express.json())
registerDoneTaskRoute(app, {
  db: h.slayDb,
  taskBus: ipcMain,
  notifyRenderer: () => {
    notifyCount++
  },
  menu: {
    emit: (channel: string, ...args: unknown[]) => {
      if (channel === 'close-task') closeEmits.push(args[0] as string)
      return true
    }
  },
  legacyBroadcast: (channel: string, ...args: unknown[]) => {
    legacySends.push({ channel, args })
  },
  taskAgents: { midReplySessionIds: async (taskId: string) => midReply.get(taskId) ?? [] }
} as never)
const rest = await mountRestApp(app)

// A second mount with NO menu / legacyBroadcast slot — the standalone-hub shape,
// where nothing can close a UI tab. `closed:false` is what lets the CLI warn
// instead of silently pretending the tab went away.
const headlessApp = express()
headlessApp.use(express.json())
registerDoneTaskRoute(headlessApp, {
  db: h.slayDb,
  taskBus: ipcMain,
  notifyRenderer: () => {}
})
const headlessRest = await mountRestApp(headlessApp)

// A third mount whose menu bus is WIRED but has no listener attached — the
// Electron host mid-reconnect, when the renderer's tRPC subscription is briefly
// detached. `emit()` returns false here, so keying `closed` off it would warn
// spuriously about a tab that does close. Capability, not listener presence.
const noListenerApp = express()
noListenerApp.use(express.json())
registerDoneTaskRoute(noListenerApp, {
  db: h.slayDb,
  taskBus: ipcMain,
  notifyRenderer: () => {},
  menu: { emit: () => false }
} as never)
const noListenerRest = await mountRestApp(noListenerApp)

function seedTask(pid = projectId, id: string = crypto.randomUUID(), status = 'todo'): string {
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, pid, 'T', status, 3, 0)
  return id
}

function reset(): void {
  closeEmits.length = 0
  legacySends.length = 0
  notifyCount = 0
}

type DoneBody = {
  ok: boolean
  data: { id: string; title: string; status: string; closed: boolean }
  error: string
}

describe('POST /api/tasks/:id/done', () => {
  test('CLI self-completion while its agent is mid-reply: refused without --force; --force completes and stops agents', async () => {
    const id = seedTask()
    h.db.prepare("UPDATE tasks SET agent_id='codex-chat' WHERE id=?").run(id)
    midReply.set(id, [`${id}:${id}`])
    const root = mkdtempSync(join(tmpdir(), 'slay-self-done-'))
    const stops: string[] = []
    setTaskAgentsStopper((taskId) => {
      stops.push(taskId)
    })
    configureTaskRuntimeAdapters({
      getDataRoot: () => root,
      onReachedTerminal: onTaskReachedTerminal
    })
    const slay = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [resolve(import.meta.dirname, '../../../../../cli/dist/slay.js'), 'tasks', 'done', ...args],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            SLAYZONE_ROOT: root,
            SLAYZONE_DEV: '1',
            SLAYZONE_HUB_ADDRESS: `127.0.0.1:${rest.port}`,
            SLAYZONE_TASK_ID: id
          }
        }
      )
    try {
      const refused = await slay().then(
        () => null,
        (err: { code: number; stderr: string }) => err
      )
      expect(refused?.code).toBe(1)
      expect(refused?.stderr).toContain('mid-reply')
      expect(refused?.stderr).toContain('--force')
      expect(stops).toEqual([])
      expect(h.db.prepare('SELECT status FROM tasks WHERE id=?').get(id)).toEqual({
        status: 'todo'
      })

      await slay('--force')
      expect(stops).toEqual([id])
      expect(h.db.prepare('SELECT status FROM tasks WHERE id=?').get(id)).toEqual({
        status: 'done'
      })
    } finally {
      midReply.delete(id)
      configureTaskRuntimeAdapters({ getDataRoot: () => tmpdir() })
      setTaskAgentsStopper(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('409: an agent mid-reply refuses done and writes nothing; force completes', async () => {
    const id = seedTask()
    midReply.set(id, [`${id}:a`, `${id}:b`])
    try {
      reset()
      const refused = await rest.request<DoneBody & { code: string }>(
        'POST',
        `/api/tasks/${id}/done`,
        { close: true }
      )
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe('agent_mid_reply')
      expect(refused.body.error).toContain('2 agents mid-reply')
      expect(closeEmits).toEqual([])
      expect(h.db.prepare('SELECT status FROM tasks WHERE id=?').get(id)).toEqual({
        status: 'todo'
      })
      const forced = await rest.request<DoneBody>('POST', `/api/tasks/${id}/done`, {
        force: true
      })
      expect(forced.status).toBe(200)
      expect(forced.body.data.status).toBe('done')
    } finally {
      midReply.delete(id)
    }
  })

  test('an idle agent (nothing mid-reply) does not block done', async () => {
    const id = seedTask()
    const res = await rest.request<DoneBody>('POST', `/api/tasks/${id}/done`, {})
    expect(res.status).toBe(200)
  })

  test('happy: writes the project default-columns done status + dual-emits', async () => {
    const id = seedTask()
    reset()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:updated')
    const res = await rest.request<DoneBody>('POST', `/api/tasks/${id}/done`, {})
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.id).toBe(id)
    expect(res.body.data.title).toBe('T')
    expect(res.body.data.status).toBe('done')
    const row = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('done')
    expect(spy.calls.length).toBe(1)
    const emits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:update:done')
    expect(emits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('happy: CUSTOM columns resolve to the project completed column, not literal "done"', async () => {
    const id = seedTask(customProjectId)
    const res = await rest.request<DoneBody>('POST', `/api/tasks/${id}/done`, {})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('closed')
    const row = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('closed')
  })

  test('happy: unique id prefix resolves (CLI addresses tasks by prefix)', async () => {
    const id = seedTask(projectId, `11111111-${crypto.randomUUID().slice(9)}`)
    const res = await rest.request<DoneBody>('POST', '/api/tasks/11111111/done', {})
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(id)
  })

  test('no close requested: no close-task emit, closed=false', async () => {
    const id = seedTask()
    reset()
    const res = await rest.request<DoneBody>('POST', `/api/tasks/${id}/done`, {})
    expect(res.body.data.closed).toBe(false)
    expect(closeEmits.length).toBe(0)
    expect(legacySends.length).toBe(0)
  })

  test('close=true: emits close-task with the RESOLVED full id, closed=true', async () => {
    const id = seedTask(projectId, `22222222-${crypto.randomUUID().slice(9)}`)
    reset()
    const res = await rest.request<DoneBody>('POST', '/api/tasks/22222222/done', { close: true })
    expect(res.status).toBe(200)
    expect(res.body.data.closed).toBe(true)
    expect(closeEmits).toEqual([id])
    const legacy = legacySends.find((s) => s.channel === 'app:close-task')
    expect(legacy!.args[0]).toBe(id)
  })

  test('close=true with no menu/broadcast slot: closed=false (nothing can close a tab)', async () => {
    const id = seedTask()
    const res = await headlessRest.request<DoneBody>('POST', `/api/tasks/${id}/done`, {
      close: true
    })
    expect(res.status).toBe(200)
    expect(res.body.data.closed).toBe(false)
    // The status write still happened — only the UI side-effect was unavailable.
    const row = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('done')
  })

  test('close=true with a wired-but-unlistened menu bus: still closed=true', async () => {
    const id = seedTask()
    const res = await noListenerRest.request<DoneBody>('POST', `/api/tasks/${id}/done`, {
      close: true
    })
    expect(res.status).toBe(200)
    // emit() returned false (no listener), but a close channel IS wired — reporting
    // false here would make the CLI warn about a tab that does get closed.
    expect(res.body.data.closed).toBe(true)
  })

  test('400: ambiguous prefix lists candidates and writes nothing', async () => {
    const a = seedTask(projectId, `33333333-aaaa-${crypto.randomUUID().slice(14)}`)
    const b = seedTask(projectId, `33333333-cccc-${crypto.randomUUID().slice(14)}`)
    reset()
    const res = await rest.request<DoneBody>('POST', '/api/tasks/33333333/done', {})
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.includes('Ambiguous id prefix "33333333"')).toBe(true)
    expect(res.body.error.includes(a.slice(0, 8))).toBe(true)
    expect(res.body.error.includes(b.slice(0, 8))).toBe(true)
    const rows = h.db.prepare('SELECT status FROM tasks WHERE id IN (?, ?)').all(a, b) as Array<{
      status: string
    }>
    expect(rows.every((r) => r.status === 'todo')).toBe(true)
    expect(closeEmits.length).toBe(0)
  })

  test('404: unknown prefix names what was searched for', async () => {
    const res = await rest.request<DoneBody>('POST', '/api/tasks/deadbeef/done', {})
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Task not found: deadbeef')
  })

  test('404: a non-uuid id is just a prefix that matches nothing', async () => {
    const res = await rest.request<DoneBody>('POST', '/api/tasks/not-a-uuid/done', {})
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Task not found: not-a-uuid')
  })

  test('happy: missing body is treated as no close (CLI posts {} today)', async () => {
    const id = seedTask()
    const res = await rest.request<DoneBody>('POST', `/api/tasks/${id}/done`)
    expect(res.status).toBe(200)
    expect(res.body.data.closed).toBe(false)
  })
})

afterAll(async () => {
  await rest.close()
  await headlessRest.close()
  await noListenerRest.close()
  h.cleanup()
})
