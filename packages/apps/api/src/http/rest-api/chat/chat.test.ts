/**
 * REST: /api/chat/:id/* contract tests against a stub chat runtime (the hub's
 * chat relay is a capability slot, `RestApiDeps.chat`).
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/chat/chat.test.ts
 */
import express from 'express'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import type { RestApiDeps } from '../types'
import { createFakeChat } from './chat-access-testkit'
import { registerChatRoutes } from './index.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const chatTask = crypto.randomUUID()
const ptyTask = crypto.randomUUID()
const otherTask = crypto.randomUUID()
const insertTask = h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
insertTask.run(chatTask, projectId, 'Chat task')
insertTask.run(ptyTask, projectId, 'Terminal task')
insertTask.run(otherTask, projectId, 'Other task')
h.db
  .prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)')
  .run('side-tab', chatTask, 'claude-chat', 1)
h.db
  .prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)')
  .run('foreign-tab', otherTask, 'claude-chat', 1)

const fake = createFakeChat({ ptyTasks: [ptyTask] })
const chat = fake.chat

function mount(deps: Partial<RestApiDeps>) {
  const app = express()
  app.use(express.json())
  registerChatRoutes(app, { db: h.slayDb, notifyRenderer: () => {}, ...deps })
  return mountRestApp(app)
}
const rest = await mount({ chat })
const bare = await mount({})

afterAll(async () => {
  await rest.close()
  await bare.close()
  h.cleanup()
})

beforeEach(() => fake.reset())

const bashPrompt = (requestId: string): AgentEvent =>
  ({
    kind: 'permission-request',
    requestId,
    toolName: 'Bash',
    toolUseId: `tu-${requestId}`,
    input: { command: 'rm -rf build' }
  }) as AgentEvent

type Ok<T> = { ok: true; data: T }

describe('addressing', () => {
  test('501 without a chat runtime', async () => {
    const res = await bare.request('GET', `/api/chat/${chatTask}/status`)
    expect(res.status).toBe(501)
  })

  test('a task prefix resolves; unknown task 404', async () => {
    const res = await rest.request<Ok<{ taskId: string }>>(
      'GET',
      `/api/chat/${chatTask.slice(0, 8)}/status`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.taskId).toBe(chatTask)
    expect((await rest.request('GET', '/api/chat/ffffffff/status')).status).toBe(404)
  })

  test('a terminal-agent task is refused with a pointer to slay agent', async () => {
    const res = await rest.request<{ error: string }>('GET', `/api/chat/${ptyTask}/status`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/slay agent/)
  })

  test('another chat tab of the task; never another task’s tab', async () => {
    const side = await rest.request<Ok<{ tabId: string }>>(
      'GET',
      `/api/chat/${chatTask}/status?tab=side-tab`
    )
    expect(side.body.data.tabId).toBe('side-tab')
    expect((await rest.request('GET', `/api/chat/${chatTask}/status?tab=foreign-tab`)).status).toBe(
      404
    )
  })
})

describe('status + prompts', () => {
  test('status reports the turn, prompts and queue', async () => {
    fake.status = { state: 'idle', turnOpen: true, pendingRequestIds: ['r1'], outboxInFlight: 0 }
    fake.queue = [{ id: 'q1', send: 'next', position: 0, createdAt: 'now' }]
    const res = await rest.request<Ok<Record<string, unknown>>>(
      'GET',
      `/api/chat/${chatTask}/status`
    )
    expect(res.body.data).toMatchObject({
      state: 'idle',
      turnOpen: true,
      pendingPrompts: 1,
      queued: 1,
      mode: 'claude-chat',
      cwd: '/live'
    })
  })

  test('prompts lists only what the computer still waits on', async () => {
    fake.buffer = [
      { seq: 1, event: bashPrompt('r-old') },
      { seq: 2, event: bashPrompt('r-new') }
    ]
    fake.status = { state: 'idle', turnOpen: true, pendingRequestIds: ['r-new'], outboxInFlight: 0 }
    const res = await rest.request<
      Ok<Array<{ requestId: string; kind: string; options: Array<{ id: string }> }>>
    >('GET', `/api/chat/${chatTask}/prompts`)
    expect(res.body.data.map((p) => p.requestId)).toEqual(['r-new'])
    expect(res.body.data[0].kind).toBe('permission')
    expect(res.body.data[0].options.map((o) => o.id)).toContain('no')
  })

  // Bypass still gets prompts (the CLI's own safety checks); "switch to auto"
  // there would downgrade the session, so the CLI offers it only outside bypass.
  test.each([
    ['auto-accept', true],
    ['bypass', false]
  ])('session in %s: "switch to auto mode" offered = %s', async (chatMode, offered) => {
    fake.autoOptedIn = true
    fake.chatMode = chatMode
    fake.buffer = [{ seq: 1, event: bashPrompt('r1') }]
    fake.status = { state: 'idle', turnOpen: true, pendingRequestIds: ['r1'], outboxInFlight: 0 }
    const res = await rest.request<Ok<Array<{ options: Array<{ id: string }> }>>>(
      'GET',
      `/api/chat/${chatTask}/prompts`
    )
    expect(res.body.data[0].options.map((o) => o.id).includes('yes-auto')).toBe(offered)
  })
})

describe('answering a prompt', () => {
  beforeEach(() => {
    fake.buffer = [{ seq: 1, event: bashPrompt('req-12345') }]
    fake.status = {
      state: 'idle',
      turnOpen: true,
      pendingRequestIds: ['req-12345'],
      outboxInFlight: 0
    }
  })

  test('allow by id prefix sends the card’s Yes', async () => {
    const res = await rest.request<Ok<{ optionId: string }>>(
      'POST',
      `/api/chat/${chatTask}/prompts/req-1`,
      { option: 'allow' }
    )
    expect(res.status).toBe(200)
    expect(fake.calls).toContainEqual([
      'respondPermission',
      chatTask,
      { requestId: 'req-12345', optionId: 'yes', decision: { behavior: 'allow' } }
    ])
  })

  test('an answer that does not fit is a 400; no pending prompt is a 409', async () => {
    expect(
      (await rest.request('POST', `/api/chat/${chatTask}/prompts/req`, { option: 'maybe' })).status
    ).toBe(400)
    fake.status = { state: 'idle', turnOpen: false, pendingRequestIds: [], outboxInFlight: 0 }
    expect(
      (await rest.request('POST', `/api/chat/${chatTask}/prompts/req`, { option: 'allow' })).status
    ).toBe(409)
    expect(fake.calls.filter((c) => c[0] === 'respondPermission')).toEqual([])
  })
})

describe('send', () => {
  test('queues like the composer, with the caller’s message id', async () => {
    const res = await rest.request<Ok<{ messageId: string; started: boolean }>>(
      'POST',
      `/api/chat/${chatTask}/send`,
      { text: 'hello', messageId: 'm-1' }
    )
    expect(res.body.data).toMatchObject({ messageId: 'm-1', started: false, steered: null })
    expect(fake.calls).toContainEqual([
      'push',
      chatTask,
      'hello',
      'hello',
      { id: 'm-1', content: [{ type: 'text', text: 'hello' }], expectedMode: 'claude-chat' }
    ])
  })

  test('starts the main agent first when nothing runs', async () => {
    fake.status = null
    const res = await rest.request<Ok<{ started: boolean }>>('POST', `/api/chat/${chatTask}/send`, {
      text: 'wake up'
    })
    expect(res.body.data.started).toBe(true)
    expect(fake.calls[0]).toEqual(['startMain', chatTask])
  })

  test('steer takes it into the running turn', async () => {
    const res = await rest.request<Ok<{ steered: boolean }>>('POST', `/api/chat/${chatTask}/send`, {
      text: 'also this',
      steer: true
    })
    expect(res.body.data.steered).toBe(true)
    expect(fake.calls.some((c) => c[0] === 'steer')).toBe(true)
  })

  test('empty text is a 400', async () => {
    expect((await rest.request('POST', `/api/chat/${chatTask}/send`, { text: '  ' })).status).toBe(
      400
    )
  })
})

describe('wait', () => {
  test('idle at once when the turn is closed and nothing is queued', async () => {
    const res = await rest.request<Ok<{ outcome: string }>>('GET', `/api/chat/${chatTask}/wait`)
    expect(res.body.data.outcome).toBe('idle')
  })

  test('a parked turn (idle state, pending prompt) answers prompt, not idle', async () => {
    fake.status = { state: 'idle', turnOpen: true, pendingRequestIds: ['r1'], outboxInFlight: 0 }
    const res = await rest.request<Ok<{ outcome: string }>>('GET', `/api/chat/${chatTask}/wait`)
    expect(res.body.data.outcome).toBe('prompt')
  })

  test('waits through a running turn until it settles', async () => {
    fake.status = { state: 'running', turnOpen: true, pendingRequestIds: [], outboxInFlight: 1 }
    const pending = rest.request<Ok<{ outcome: string }>>(
      'GET',
      `/api/chat/${chatTask}/wait?timeout=10000`
    )
    await new Promise((r) => setTimeout(r, 100))
    fake.status = { state: 'idle', turnOpen: false, pendingRequestIds: [], outboxInFlight: 0 }
    fake.state(`${chatTask}:${chatTask}`, 'idle')
    expect((await pending).body.data.outcome).toBe('idle')
  })

  test('answered follows the message’s delivery', async () => {
    fake.status = { state: 'running', turnOpen: true, pendingRequestIds: [], outboxInFlight: 1 }
    const pending = rest.request<Ok<{ outcome: string }>>(
      'GET',
      `/api/chat/${chatTask}/wait?until=answered&message=m-9&timeout=10000`
    )
    await new Promise((r) => setTimeout(r, 100))
    fake.emit(
      chatTask,
      { kind: 'user-message-delivery', id: 'm-9', state: 'answered' } as AgentEvent,
      5
    )
    expect((await pending).body.data.outcome).toBe('answered')
  })

  test('a dead session ends the wait', async () => {
    fake.status = { state: 'dead', turnOpen: false, pendingRequestIds: [], outboxInFlight: 0 }
    const res = await rest.request<Ok<{ outcome: string }>>('GET', `/api/chat/${chatTask}/wait`)
    expect(res.body.data.outcome).toBe('dead')
  })

  test('timeout', async () => {
    fake.status = { state: 'running', turnOpen: true, pendingRequestIds: [], outboxInFlight: 0 }
    const res = await rest.request<Ok<{ outcome: string }>>(
      'GET',
      `/api/chat/${chatTask}/wait?timeout=1000`
    )
    expect(res.body.data.outcome).toBe('timeout')
  })
})

describe('transcript + control', () => {
  test('transcript renders the saved history as text', async () => {
    fake.buffer = [
      {
        seq: 1,
        event: {
          kind: 'user-message',
          id: 'u1',
          text: 'hi',
          content: [{ type: 'text', text: 'hi' }]
        } as AgentEvent
      },
      {
        seq: 2,
        event: { kind: 'assistant-text', messageId: 'm1', text: 'hello there' } as AgentEvent
      }
    ]
    const res = await fetch(`${rest.url}/api/chat/${chatTask}/transcript`)
    expect(await res.text()).toBe('> hi\n\nhello there\n')
  })

  test('interrupt only when a turn is open; with the live folder', async () => {
    await rest.request('POST', `/api/chat/${chatTask}/interrupt`, {})
    expect(fake.calls.filter((c) => c[0] === 'interrupt')).toEqual([])
    fake.status = { state: 'running', turnOpen: true, pendingRequestIds: [], outboxInFlight: 0 }
    await rest.request('POST', `/api/chat/${chatTask}/interrupt`, {})
    expect(fake.calls).toContainEqual([
      'interrupt',
      { tabId: chatTask, taskId: chatTask, mode: 'claude-chat', cwd: '/live' }
    ])
  })

  test('stop returns the popped message', async () => {
    const res = await rest.request<Ok<{ popped: boolean; text: string }>>(
      'POST',
      `/api/chat/${chatTask}/stop`,
      {}
    )
    expect(res.body.data).toEqual({ popped: true, text: 'undo me' })
  })

  test('settings apply each given field and report the result', async () => {
    const res = await rest.request<Ok<Record<string, string>>>(
      'POST',
      `/api/chat/${chatTask}/settings`,
      {
        model: 'opus'
      }
    )
    expect(res.body.data).toEqual({ permissionMode: 'auto-accept', model: 'opus', effort: 'high' })
    expect(fake.calls.map((c) => c[0])).toEqual(['setModel'])
    expect((await rest.request('POST', `/api/chat/${chatTask}/settings`, {})).status).toBe(400)
  })
})

/** Read an SSE stream until `until` matches what arrived (or time out). */
async function readSse(
  path: string,
  act: () => void | Promise<void>,
  until: (text: string) => boolean
): Promise<string> {
  const ac = new AbortController()
  const res = await fetch(`${rest.url}${path}`, { signal: ac.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 3_000
  // The headers are flushed once the route subscribed: act only then.
  await act()
  try {
    // One read in flight at a time: a chunk delivered to an abandoned read is lost.
    let pending = reader.read()
    while (!until(text) && Date.now() < deadline) {
      const next = await Promise.race([
        pending,
        new Promise<null>((r) => setTimeout(() => r(null), 100))
      ])
      if (!next) continue
      if (next.done) break
      text += decoder.decode(next.value)
      pending = reader.read()
    }
  } finally {
    // The loop leaves one read in flight. Cancelling the reader settles it (done)
    // and closes the stream; an abort alone would reject it with nobody listening.
    await reader.cancel()
    ac.abort()
  }
  return text
}

// H1: computers send the hub full chat events only for tabs a hub client watches
// (docs/direct-link.md). `slay chat follow` is such a client.
describe('follow', () => {
  test('streams a tab no other client watches: it watches the tab itself', async () => {
    const text = await readSse(
      `/api/chat/${chatTask}/follow`,
      () => {
        expect(fake.watchers.get(chatTask)).toBe(1)
        fake.emit(chatTask, bashPrompt('req-follow'), 5)
      },
      (t) => t.includes('event: prompt')
    )
    expect(text).toContain('event: prompt')
    expect(text).toContain('req-follow')
    await new Promise((r) => setTimeout(r, 50))
    // Closing the stream ends its watch.
    expect(fake.watchers.has(chatTask)).toBe(false)
  })

  test('an event the hub only got a summary of is read back from the saved history', async () => {
    const text = await readSse(
      `/api/chat/${chatTask}/follow`,
      () => {
        // Saved before the computer applied the watch: summary only, no full event.
        fake.watchers.clear()
        fake.emit(chatTask, bashPrompt('req-gap'), 7)
      },
      (t) => t.includes('event: prompt')
    )
    expect(text).toContain('req-gap')
  })

  // R3: seq 7 is saved before the watch applies (summary only), then seq 8 arrives in
  // full within the grace. 7 must still be shown, before 8.
  test('a full event past a summary-only seq waits until that seq is read back', async () => {
    const text = await readSse(
      `/api/chat/${chatTask}/follow`,
      () => {
        fake.watchers.clear()
        fake.emit(chatTask, bashPrompt('req-seven'), 7)
        fake.watchers.set(chatTask, 1)
        fake.emit(chatTask, bashPrompt('req-eight'), 8)
      },
      (t) => t.includes('req-seven') && t.includes('req-eight')
    )
    expect(text).toContain('req-seven')
    expect(text.indexOf('req-seven')).toBeLessThan(text.indexOf('req-eight'))
  })
})
