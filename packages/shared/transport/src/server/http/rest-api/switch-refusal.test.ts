/**
 * REST shape of a hub-switch refusal: 403 `{ ok: false, error, code }`, one audit line,
 * and the refusing route never touches what it would have acted on.
 *
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` refuses every `/api/processes` route (the hub has
 * no process of its own to list, follow or kill) and automation rules that exec on the
 * hub, at save (POST/PATCH) and at run. With the switch unset the same routes answer
 * as before.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/transport/src/server/http/rest-api/switch-refusal.test.ts
 */
import { describe, test, expect, afterAll } from 'vitest'
import express from 'express'
import { AutomationEngine } from '@slayzone/automations/server'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { createTestHarness } from '../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../test-utils/rest-harness.js'
import type { RestApiDeps } from './types'
import { registerProcessesListRoute } from './processes/list.js'
import { registerProcessesLogsRoute } from './processes/logs.js'
import { registerProcessesFollowRoute } from './processes/follow.js'
import { registerProcessesDeleteRoute } from './processes/delete.js'
import { registerAutomationsCrudRoutes } from './automations/crud.js'
import { registerAutomationsRunRoute } from './automations/run.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', h.tmpDir())

// Counts every touch of the process registry — a refused route must make none.
let processTouches = 0
const processes = {
  listAll: () => {
    processTouches++
    return []
  },
  kill: () => {
    processTouches++
    return false
  },
  subscribeToLogs: () => {
    processTouches++
    return () => undefined
  }
}

const deps = {
  db: h.slayDb,
  notifyRenderer: () => undefined,
  processes,
  automationEngine: new AutomationEngine(h.slayDb, () => undefined)
} as unknown as RestApiDeps
const app = express()
app.use(express.json())
registerProcessesListRoute(app, deps)
registerProcessesLogsRoute(app, deps)
registerProcessesFollowRoute(app, deps)
registerProcessesDeleteRoute(app, deps)
registerAutomationsCrudRoutes(app, deps)
registerAutomationsRunRoute(app, deps)
const rest = await mountRestApp(app)

const lines: Array<{ event: string; outcome: string; detail: Record<string, unknown> }> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))

type Refusal = { ok: boolean; error: string; code: string }
function expectRefused(res: { status: number; body: unknown }, code: string): void {
  const body = res.body as Refusal
  expect(res.status).toBe(403)
  expect(body.ok).toBe(false)
  expect(body.code).toBe(code)
  expect(body.error.includes('SLAYZONE_HUB_ENABLE_PROCESSES=0')).toBe(true)
}

const runCommand = [{ type: 'run_command', params: { command: 'echo hi' } }]

process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'

afterAll(async () => {
  setSecurityLogSink()
  await rest.close()
})

describe('processes switched off', () => {
  for (const [method, path, op] of [
    ['GET', '/api/processes', 'list'],
    ['GET', '/api/processes/p1/logs', 'logs'],
    ['GET', '/api/processes/p1/follow', 'follow'],
    ['DELETE', '/api/processes/p1', 'kill']
  ] as const) {
    test(`${method} ${path}: 403 HUB_PROCESSES_DISABLED, one audit line`, async () => {
      const before = lines.length
      expectRefused(await rest.request(method, path), 'HUB_PROCESSES_DISABLED')
      expect(lines.length).toBe(before + 1)
      expect(lines[before].event).toBe('hub.process.spawn')
      expect(lines[before].detail.op).toBe(op)
    })
  }

  test('the process registry was never touched', () => {
    expect(processTouches).toBe(0)
  })

  test('POST /api/automations with run_command: 403, nothing stored', async () => {
    const before = lines.length
    const res = await rest.request('POST', '/api/automations', {
      project: 'Alpha',
      name: 'cmd',
      trigger_config: { type: 'manual', params: {} },
      actions: runCommand
    })
    expectRefused(res, 'HUB_PROCESSES_DISABLED')
    expect(lines[before].event).toBe('automation.run_command')
    const n = h.db.prepare("SELECT COUNT(*) AS n FROM automations WHERE name = 'cmd'").get() as {
      n: number
    }
    expect(n.n).toBe(0)
  })

  const directId = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order)
       VALUES (?, ?, 'direct', 1, '{"type":"manual","params":{}}', '[]', '[]', 0)`
    )
    .run(directId, projectId)

  test('PATCH /api/automations/:id setting run_command: 403, row unchanged', async () => {
    expectRefused(
      await rest.request('PATCH', `/api/automations/${directId}`, { actions: runCommand }),
      'HUB_PROCESSES_DISABLED'
    )
    const row = h.db.prepare('SELECT actions FROM automations WHERE id = ?').get(directId) as {
      actions: string
    }
    expect(row.actions).toBe('[]')
  })

  test('PATCH /api/automations/:id renaming: still works', async () => {
    const res = await rest.request('PATCH', `/api/automations/${directId}`, { name: 'renamed' })
    expect(res.status).toBe(200)
  })

  test('POST /api/automations/:id/run on a run_command row from the database: 403', async () => {
    h.db
      .prepare('UPDATE automations SET actions = ? WHERE id = ?')
      .run(JSON.stringify(runCommand), directId)
    const before = lines.length
    expectRefused(
      await rest.request('POST', `/api/automations/${directId}/run`),
      'HUB_PROCESSES_DISABLED'
    )
    expect(lines[before].detail.op).toBe('run')
    const runs = h.db
      .prepare('SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ?')
      .get(directId) as { n: number }
    expect(runs.n).toBe(0)
  })
})

describe('processes on (default)', () => {
  test('GET /api/processes answers again', async () => {
    delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
    const before = lines.length
    const res = await rest.request('GET', '/api/processes')
    expect(res.status).toBe(200)
    expect(processTouches).toBe(1)
    expect(lines.length).toBe(before)
  })
})
