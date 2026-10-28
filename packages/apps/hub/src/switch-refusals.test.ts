/**
 * The Normain hub's switches end to end over tRPC (T-04, T-05, T-07):
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` and `SLAYZONE_HUB_ENABLE_INTEGRATIONS=0`, wired the
 * way composition.ts wires the real process manager, automation engine and
 * integration ops behind the real `appRouter`.
 *
 * Asserts the wire shape a client sees — FORBIDDEN (403) with `data.appCode` and a
 * message naming the switch — the audit line each refusal writes (with the caller as
 * actor), that nothing reached a process backend or wrote a credential, and that the
 * reads the UI makes keep answering. With the switches unset the same calls behave as
 * before, and an unrelated error keeps its shape.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/switch-refusals.test.ts
 */
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { afterAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { appRouter, setAppDeps } from '@slayzone/api'
import {
  createProcess,
  initProcessManager,
  killProcess,
  killTaskProcesses,
  listAllProcesses,
  listForTask,
  processEvents,
  restartProcess,
  setProcessBackend,
  setProcessesDeps,
  spawnProcess,
  stopProcess,
  updateProcess
} from '@slayzone/processes/server'
import { AutomationEngine } from '@slayzone/automations/server'
import {
  createIntegrationOps,
  ensureIntegrationSchema,
  setCredentialCipher,
  setIntegrationOps
} from '@slayzone/integrations/server'
import { wireIntegrationPush } from './integrations-push.js'

const h = await createTestHarness()
await ensureIntegrationSchema(h.slayDb)
setCredentialCipher(null)

// A process row persisted with a pid, as an earlier run would have left it.
h.db
  .prepare(
    `INSERT INTO processes (id, task_id, project_id, label, command, cwd, auto_restart, pid)
     VALUES ('persisted-1', NULL, NULL, 'dev', 'sleep 30', '/tmp', 1, 999999)`
  )
  .run()

// Same wiring as composition.ts, with a backend that records instead of spawning.
let backendSpawns = 0
setProcessBackend({
  spawn: () => {
    backendSpawns++
    throw new Error('backend reached')
  },
  getCommandLine: async () => null,
  killByPid: () => undefined
})
setProcessesDeps({
  create: createProcess,
  spawn: spawnProcess,
  update: updateProcess,
  stop: stopProcess,
  kill: killProcess,
  restart: restartProcess,
  listForTask,
  listAll: listAllProcesses,
  killTask: killTaskProcesses,
  events: processEvents
})
const engine = new AutomationEngine(h.slayDb, () => undefined)
setIntegrationOps(createIntegrationOps(h.slayDb))
let signInStarts = 0
setAppDeps({
  authGithubSystemSignIn: async () => {
    signInStarts++
    return { ok: true, verifier: 'v', pending: true }
  }
} as never)

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', h.tmpDir())

const lines: Array<Record<string, unknown> & { detail: Record<string, unknown> }> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))

type WireError = {
  message: string
  data: { code: string; httpStatus: number; appCode?: string }
}

/** One tRPC call over the HTTP adapter — the same error formatting the ws adapter uses. */
async function call(
  path: string,
  input?: unknown,
  method: 'POST' | 'GET' = 'POST'
): Promise<{ status: number; data?: unknown; error?: WireError }> {
  const url =
    method === 'GET'
      ? `http://hub/trpc/${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`}`
      : `http://hub/trpc/${path}`
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(superjson.serialize(input)) : undefined
    }),
    router: appRouter,
    createContext: () => ({
      db: h.slayDb,
      dataRoot: '/tmp',
      automationEngine: engine,
      req: { socket: { remoteAddress: '198.51.100.9' } } as never,
      principal: { userId: 'user-7', role: 'user' as const, scopes: ['full'] as const }
    })
  })
  const body = (await res.json()) as {
    result?: { data: { json: unknown } }
    error?: { json: WireError }
  }
  return { status: res.status, data: body.result?.data.json, error: body.error?.json }
}

const credentialRows = (): number =>
  (
    h.db
      .prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'integration:credential:%'")
      .get() as { n: number }
  ).n

function expectRefused(
  res: Awaited<ReturnType<typeof call>>,
  appCode: string,
  variable: string
): void {
  expect(res.status).toBe(403)
  expect(res.error?.data.code).toBe('FORBIDDEN')
  expect(res.error?.data.appCode).toBe(appCode)
  expect(res.error?.message).toContain(`${variable}=0`)
}

process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS = '0'

describe('Normain hub: processes + integrations switched off', () => {
  test('boot: the persisted process row is not loaded (no restart, no pid sweep)', async () => {
    await initProcessManager(h.slayDb)
    expect(listAllProcesses()).toHaveLength(0)
  })

  for (const [proc, input] of [
    [
      'create',
      {
        projectId,
        taskId: null,
        label: 'dev',
        command: 'sleep 30',
        cwd: '/tmp',
        autoRestart: false
      }
    ],
    [
      'spawn',
      {
        projectId,
        taskId: null,
        label: 'dev',
        command: 'sleep 30',
        cwd: '/tmp',
        autoRestart: false
      }
    ],
    ['update', { processId: 'persisted-1', updates: { command: 'sleep 31' } }],
    ['restart', { processId: 'persisted-1' }]
  ] as const) {
    test(`processes.${proc}: FORBIDDEN, audited as the caller`, async () => {
      const before = lines.length
      const res = await call(`processes.${proc}`, input)
      expectRefused(res, 'HUB_PROCESSES_DISABLED', 'SLAYZONE_HUB_ENABLE_PROCESSES')
      expect(lines.length).toBe(before + 1)
      const line = lines[before]
      expect(line.event).toBe('hub.process.spawn')
      expect(line.outcome).toBe('denied')
      expect(line.actor).toBe('user-7')
      expect(line.ip).toBe('198.51.100.9')
      expect(line.route).toBe(`trpc processes.${proc}`)
      expect(line.detail.op).toBe(proc)
    })
  }

  test('no process backend was ever asked to spawn', () => {
    expect(backendSpawns).toBe(0)
  })

  test('processes.listAll still answers (the UI reads it)', async () => {
    const res = await call('processes.listAll', undefined, 'GET')
    expect(res.status).toBe(200)
    expect(res.data).toEqual([])
  })

  test('automations.create with run_command: FORBIDDEN, nothing stored', async () => {
    const before = lines.length
    const res = await call('automations.create', {
      project_id: projectId,
      name: 'cmd',
      trigger_config: { type: 'manual', params: {} },
      actions: [{ type: 'run_command', params: { command: 'echo hi' } }]
    })
    expectRefused(res, 'HUB_PROCESSES_DISABLED', 'SLAYZONE_HUB_ENABLE_PROCESSES')
    expect(lines[before].event).toBe('automation.run_command')
    const list = await call('automations.getByProject', { projectId }, 'GET')
    expect(list.status).toBe(200)
    expect(list.data).toEqual([])
  })

  test('automations.runManual on a rule written into the database: FORBIDDEN', async () => {
    const id = crypto.randomUUID()
    h.db
      .prepare(
        `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order)
         VALUES (?, ?, 'direct', 1, '{"type":"manual","params":{}}', '[]', ?, 0)`
      )
      .run(id, projectId, JSON.stringify([{ type: 'run_command', params: { command: 'echo hi' } }]))
    const before = lines.length
    const res = await call('automations.runManual', { id })
    expectRefused(res, 'HUB_PROCESSES_DISABLED', 'SLAYZONE_HUB_ENABLE_PROCESSES')
    expect(lines[before].event).toBe('automation.run_command')
    expect(lines[before].detail.op).toBe('run')
  })

  for (const [proc, input] of [
    ['connectGithub', { token: 'ghp_x' }],
    ['connectLinear', { apiKey: 'lin_x' }],
    ['connectJira', { cloudDomain: 'acme.atlassian.net', email: 'a@b.c', apiToken: 't' }]
  ] as const) {
    test(`integrations.${proc}: FORBIDDEN, no credential written`, async () => {
      const before = lines.length
      const res = await call(`integrations.${proc}`, input)
      expectRefused(res, 'HUB_INTEGRATIONS_DISABLED', 'SLAYZONE_HUB_ENABLE_INTEGRATIONS')
      expect(lines[before].event).toBe('integration.connect')
      expect(lines[before].route).toBe(`trpc integrations.${proc}`)
      expect(credentialRows()).toBe(0)
    })
  }

  test('integrations.listConnections still answers', async () => {
    const res = await call('integrations.listConnections', undefined, 'GET')
    expect(res.status).toBe(200)
  })

  test('app.auth.githubSystemSignIn: FORBIDDEN before the host is asked', async () => {
    const before = lines.length
    const res = await call('app.auth.githubSystemSignIn', {
      convexUrl: 'https://example.convex.site',
      redirectTo: 'slayzone://auth/callback'
    })
    expectRefused(res, 'HUB_INTEGRATIONS_DISABLED', 'SLAYZONE_HUB_ENABLE_INTEGRATIONS')
    expect(signInStarts).toBe(0)
    expect(lines[before].event).toBe('integration.connect')
    expect(lines[before].detail.op).toBe('sign_in')
  })

  test('push-on-edit is not wired', () => {
    const bus = new EventEmitter()
    wireIntegrationPush({
      db: h.slayDb,
      taskBus: bus,
      notifyTasksChanged: () => undefined,
      pushGithubTask: async () => undefined
    })
    expect(bus.eventNames()).toHaveLength(0)
  })
})

describe('defaults (switches unset): unchanged', () => {
  test('processes.create works and an unrelated error keeps its shape', async () => {
    delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
    delete process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS
    const before = lines.length
    const created = await call('processes.create', {
      projectId,
      taskId: null,
      label: 'dev',
      command: 'echo hi',
      cwd: '/tmp',
      autoRestart: false
    })
    expect(created.status).toBe(200)
    expect(typeof created.data).toBe('string')
    killProcess(created.data as string)

    const bad = await call('integrations.connectGithub', { token: '   ' })
    expect(bad.status).toBe(500)
    expect(bad.error?.data.code).toBe('INTERNAL_SERVER_ERROR')
    expect(bad.error?.data.appCode).toBeUndefined()
    expect(lines.length).toBe(before)
  })

  test('push-on-edit is wired', () => {
    const bus = new EventEmitter()
    wireIntegrationPush({
      db: h.slayDb,
      taskBus: bus,
      notifyTasksChanged: () => undefined,
      pushGithubTask: async () => undefined
    })
    expect(bus.listenerCount('db:tasks:update:done')).toBe(1)
  })
})

afterAll(() => {
  setProcessBackend(null)
  setSecurityLogSink()
})
