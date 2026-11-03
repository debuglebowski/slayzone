/**
 * REST: /api/agent/:id/* — one surface for a task's main agent, chat or terminal.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/agent/agent.test.ts
 */
import express from 'express'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { TypedEmitter } from '@slayzone/platform/events'
import type { ChatTurnStatus, TerminalState } from '@slayzone/terminal-contracts'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import type { ChatAccess, PtyAccess } from '../types'
import { registerAgentRoutes } from './index.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const chatTask = crypto.randomUUID()
const ptyTask = crypto.randomUUID()
const insertTask = h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
insertTask.run(chatTask, projectId, 'Chat')
insertTask.run(ptyTask, projectId, 'Terminal')
const ptySession = `${ptyTask}:${ptyTask}`

let calls: unknown[][] = []
let chatStatus: ChatTurnStatus | null = null
let ptyState: TerminalState = 'running'
let ptyLive = true
const stateCbs = new Set<(s: TerminalState) => void>()

const events = new TypedEmitter<{ event: [string, unknown, number]; exit: [string] }>()
const queueEvents = new TypedEmitter<{ 'queue-changed': [string] }>()
const chat: ChatAccess = {
  deps: () =>
    ({
      ops: {
        getTurnStatus: () => chatStatus,
        getInfo: () => ({ cwd: '/live' }),
        getBufferSince: () => [],
        interrupt: (o: unknown) => calls.push(['chat.interrupt', o])
      },
      queueOps: {
        list: () => [],
        push: (tabId: string, send: string, _o: string, opts: { id: string }) => {
          calls.push(['chat.push', tabId, send])
          return { id: opts.id }
        }
      },
      events,
      queueEvents
    }) as unknown as ReturnType<ChatAccess['deps']>,
  onStateChange: () => () => {},
  launch: async (taskId) =>
    ({
      taskId,
      tabId: taskId,
      sessionId: `${taskId}:${taskId}`,
      mode: taskId === ptyTask ? 'claude-code' : 'claude-chat',
      kind: taskId === ptyTask ? 'pty' : 'chat',
      props: {} as never,
      providerFlagsOverride: null,
      resolveCwd: async () => '/repo'
    }) as Awaited<ReturnType<ChatAccess['launch']>>,
  startMain: async () => {
    throw new Error('not used')
  }
}
const pty = {
  hasLivePty: () => ptyLive,
  hasPty: () => ptyLive,
  getState: () => ptyState,
  getBuffer: () => 'line 1\nline 2\nline 3',
  submitPty: (id: string, text: string) => (calls.push(['pty.submit', id, text]), true),
  writePty: (id: string, data: string) => (calls.push(['pty.write', id, data]), true),
  subscribeToStateChange: (_id: string, cb: (s: TerminalState) => void) => {
    stateCbs.add(cb)
    return () => stateCbs.delete(cb)
  },
  onSessionChange: () => () => {}
} as unknown as PtyAccess

const app = express()
app.use(express.json())
registerAgentRoutes(app, { db: h.slayDb, notifyRenderer: () => {}, chat, pty })
const rest = await mountRestApp(app)
afterAll(async () => {
  await rest.close()
  h.cleanup()
})
beforeEach(() => {
  calls = []
  chatStatus = { state: 'idle', turnOpen: false, pendingRequestIds: [], outboxInFlight: 0 }
  ptyState = 'running'
  ptyLive = true
})

type Ok<T> = { ok: true; data: T }

describe('a chat task', () => {
  test('send queues into the chat; status/wait read the turn', async () => {
    const sent = await rest.request<Ok<{ kind: string }>>('POST', `/api/agent/${chatTask}/send`, {
      text: 'go'
    })
    expect(sent.body.data.kind).toBe('chat')
    expect(calls).toContainEqual(['chat.push', chatTask, 'go'])
    chatStatus = { state: 'idle', turnOpen: true, pendingRequestIds: ['p'], outboxInFlight: 0 }
    const status = await rest.request<Ok<{ pendingPrompts: number }>>(
      'GET',
      `/api/agent/${chatTask}/status`
    )
    expect(status.body.data.pendingPrompts).toBe(1)
    const waited = await rest.request<Ok<{ outcome: string }>>('GET', `/api/agent/${chatTask}/wait`)
    expect(waited.body.data.outcome).toBe('prompt')
  })

  test('interrupt stops an open turn', async () => {
    chatStatus = { state: 'running', turnOpen: true, pendingRequestIds: [], outboxInFlight: 0 }
    await rest.request('POST', `/api/agent/${chatTask}/interrupt`, {})
    expect(calls[0]?.[0]).toBe('chat.interrupt')
  })
})

describe('a terminal task', () => {
  test('send submits to the main pty', async () => {
    const res = await rest.request<Ok<{ kind: string }>>('POST', `/api/agent/${ptyTask}/send`, {
      text: 'ls'
    })
    expect(res.body.data.kind).toBe('pty')
    expect(calls).toContainEqual(['pty.submit', ptySession, 'ls'])
  })

  test('wait resolves when the terminal goes idle', async () => {
    const pending = rest.request<Ok<{ outcome: string }>>(
      'GET',
      `/api/agent/${ptyTask}/wait?timeout=10000`
    )
    await new Promise((r) => setTimeout(r, 100))
    for (const cb of stateCbs) cb('idle')
    expect((await pending).body.data.outcome).toBe('idle')
  })

  test('a terminal with no session waits for nothing', async () => {
    ptyLive = false
    const res = await rest.request<Ok<{ outcome: string }>>('GET', `/api/agent/${ptyTask}/wait`)
    expect(res.body.data.outcome).toBe('dead')
  })

  test('read returns the buffer (last N lines); interrupt is Ctrl-C', async () => {
    expect(await (await fetch(`${rest.url}/api/agent/${ptyTask}/read?last=2`)).text()).toBe(
      'line 2\nline 3'
    )
    await rest.request('POST', `/api/agent/${ptyTask}/interrupt`, {})
    expect(calls).toContainEqual(['pty.write', ptySession, '\x03'])
  })
})
