/**
 * `/api/chat/*` and `/api/agent/*` read a chat's history in bounded pages, never the
 * whole log in one computer answer (2026-11-14: `slay chat read` of a 202 MB chat
 * = one 202 MB frame → the hub closed the computer's socket, 1009, and every
 * reconnect killed live agents). Each route's answer must equal what it answered
 * from the whole history, with every computer answer within the page budget —
 * from the timeline projection (`paged`) and from event pages (`full`).
 */
import express from 'express'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { chatTranscriptFromEvents, formatChatTranscript } from '@slayzone/terminal/chat-transcript'
import { buildLongSession } from '../../../../../../shared/test-utils/chat-long-session/index.js'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { registerAgentRoutes } from '../agent/index.js'
import { createFakeChat } from './chat-access-testkit'
import { registerChatRoutes } from './index.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const chatTask = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
  .run(chatTask, projectId, 'Chat')

const fake = createFakeChat()
const app = express()
app.use(express.json())
registerChatRoutes(app, { db: h.slayDb, notifyRenderer: () => {}, chat: fake.chat })
registerAgentRoutes(app, { db: h.slayDb, notifyRenderer: () => {}, chat: fake.chat })
const rest = await mountRestApp(app)

afterAll(async () => {
  await rest.close()
  h.cleanup()
})

/** A long conversation (~10k events) with a prompt still waiting from its first turn. */
const prompt: AgentEvent = {
  kind: 'permission-request',
  requestId: 'req-early-1',
  toolName: 'Bash',
  toolUseId: 'tu-early',
  input: { command: 'rm -rf build' }
} as AgentEvent
const session = buildLongSession({ events: 10_000, seed: 7, provider: 'claude' })
const events: AgentEvent[] = [
  {
    kind: 'user-message',
    id: 'u-first',
    text: 'start',
    content: [{ type: 'text', text: 'start' }]
  },
  prompt,
  { kind: 'user-message-delivery', id: 'u-first', state: 'answered' },
  ...session
] as AgentEvent[]
const history = events.map((event, seq) => ({ seq, event, at: 1_000 + seq }))
/** Small pages, so a read takes many of them. */
const PAGE = 48 * 1024

const expectedRows = (opts: { since?: number; last?: number; verbose?: boolean } = {}) =>
  chatTranscriptFromEvents(events, opts, { agentStartedTurns: true })

type Ok<T> = { ok: true; data: T }

function expectBounded() {
  expect(fake.historyAnswers.length).toBeGreaterThan(0)
  for (const a of fake.historyAnswers) {
    // No whole-history read, ever.
    expect(a.op).not.toBe('getBufferSince')
    expect(a.op).not.toBe('getReplay')
    // A page (or the projection's open snapshot) — never the whole history.
    // One unit (an event, a timeline page of 256 rows) always fits, alone.
    if (a.op !== 'openTimeline' && a.units > 1)
      expect({ op: a.op, bytes: a.bytes }).toEqual({
        op: a.op,
        bytes: expect.toSatisfy((b: number) => b <= PAGE + 64 * 1024)
      })
  }
}

describe.each([
  ['the projection (paged)', true],
  ['event pages (full)', false]
] as const)('from %s', (_label, projection) => {
  beforeEach(() => {
    fake.reset()
    fake.buffer = history.map((e) => ({ ...e }))
    fake.projection = projection
    fake.pageBytes = PAGE
    fake.status = {
      state: 'idle',
      turnOpen: true,
      pendingRequestIds: ['req-early-1'],
      outboxInFlight: 0
    }
  })

  test('transcript: the whole conversation, as text and as rows', async () => {
    const res = await fetch(`${rest.url}/api/chat/${chatTask}/transcript`)
    expect(await res.text()).toBe(formatChatTranscript(expectedRows()))
    expectBounded()
    fake.historyAnswers = []
    const json = await rest.request<Ok<{ rows: unknown[]; lastRow: number; lastSeq: number }>>(
      'GET',
      `/api/chat/${chatTask}/transcript?format=json&verbose=1`
    )
    expect(json.body.data.rows).toEqual(expectedRows({ verbose: true }))
    expect(json.body.data.lastSeq).toBe(history.length - 1)
    expectBounded()
  })

  test('transcript --last N / since: the same rows, and only what holds them is read', async () => {
    const all = await rest.request<Ok<{ rows: unknown[]; lastRow: number }>>(
      'GET',
      `/api/chat/${chatTask}/transcript?format=json`
    )
    fake.historyAnswers = []
    const last = await rest.request<Ok<{ rows: unknown[]; lastRow: number }>>(
      'GET',
      `/api/chat/${chatTask}/transcript?format=json&last=5`
    )
    expect(last.body.data.rows).toEqual(expectedRows({ last: 5 }))
    expect(last.body.data.lastRow).toBe(all.body.data.lastRow)
    expectBounded()
    if (projection)
      // The snapshot holds the newest rows: no page of older ones is needed.
      expect(
        fake.historyAnswers.filter((a) => a.op === 'timelinePages').length
      ).toBeLessThanOrEqual(1)
    const since = all.body.data.lastRow - 600
    const fromRow = await rest.request<Ok<{ rows: unknown[] }>>(
      'GET',
      `/api/chat/${chatTask}/transcript?format=json&since=${since}`
    )
    expect(fromRow.body.data.rows).toEqual(expectedRows({ since }))
  })

  test('prompts and answering: a prompt from the first turn is still found', async () => {
    const res = await rest.request<Ok<Array<{ requestId: string }>>>(
      'GET',
      `/api/chat/${chatTask}/prompts`
    )
    expect(res.body.data.map((p) => p.requestId)).toEqual(['req-early-1'])
    expectBounded()
    const answered = await rest.request<Ok<unknown>>(
      'POST',
      `/api/chat/${chatTask}/prompts/req-early`,
      { option: 'allow' }
    )
    expect(answered.status).toBe(200)
    expect(fake.calls.some((c) => c[0] === 'respondPermission')).toBe(true)
    expectBounded()
  })

  test('wait answered: a delivery saved long ago answers at once', async () => {
    fake.status = { state: 'running', turnOpen: true, pendingRequestIds: [], outboxInFlight: 1 }
    const res = await rest.request<Ok<{ outcome: string }>>(
      'GET',
      `/api/chat/${chatTask}/wait?until=answered&message=u-first&timeout=5000`
    )
    expect(res.body.data.outcome).toBe('answered')
    expectBounded()
  })

  test('wait answered: a message Stop took back (popped, then cancelled) answers its error at once', async () => {
    // Taken back after the long history: its row is gone, its delivery is saved after.
    const end = history.length
    fake.buffer.push(
      {
        seq: end,
        event: {
          kind: 'user-message',
          id: 'u-taken',
          text: 'undo me',
          content: [{ type: 'text', text: 'undo me' }]
        } as AgentEvent,
        at: 1
      },
      {
        seq: end + 1,
        event: { kind: 'user-message-popped', id: 'u-taken', text: 'undo me' } as AgentEvent,
        at: 2
      },
      {
        seq: end + 2,
        event: { kind: 'user-message-delivery', id: 'u-taken', state: 'cancelled' } as AgentEvent,
        at: 3
      }
    )
    fake.status = { state: 'idle', turnOpen: false, pendingRequestIds: [], outboxInFlight: 0 }
    const res = await rest.request<Ok<{ outcome: string; error?: string }>>(
      'GET',
      `/api/chat/${chatTask}/wait?until=answered&message=u-taken&timeout=3000`
    )
    expect(res.body.data).toMatchObject({ outcome: 'error', error: 'message cancelled' })
    expectBounded()
  })

  test('wait answered: other saved events while waiting never re-read the history', async () => {
    fake.status = { state: 'running', turnOpen: true, pendingRequestIds: [], outboxInFlight: 1 }
    const pending = rest.request<Ok<{ outcome: string }>>(
      'GET',
      `/api/chat/${chatTask}/wait?until=answered&message=u-new&timeout=10000`
    )
    await new Promise((r) => setTimeout(r, 300))
    const afterStart = fake.historyAnswers.length
    for (let i = 0; i < 5; i++)
      fake.emit(chatTask, { kind: 'stderr', text: `noise ${i}` } as AgentEvent, history.length + i)
    await new Promise((r) => setTimeout(r, 200))
    expect(fake.historyAnswers.length).toBe(afterStart)
    fake.emit(
      chatTask,
      { kind: 'user-message-delivery', id: 'u-new', state: 'answered' } as AgentEvent,
      history.length + 10
    )
    expect((await pending).body.data.outcome).toBe('answered')
    expectBounded()
  })

  test('agent read --last N: the same rows', async () => {
    const res = await fetch(`${rest.url}/api/agent/${chatTask}/read?last=4`)
    expect(await res.text()).toBe(formatChatTranscript(expectedRows({ last: 4 })))
    expectBounded()
  })

  test('follow since=-1 replays the whole conversation first, in bounded reads', async () => {
    const want = expectedRows()
    const controller = new AbortController()
    const res = await fetch(`${rest.url}/api/chat/${chatTask}/follow?since=-1`, {
      signal: controller.signal
    })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const lastRow = `"row":${want.at(-1)!.row},`
    while (!text.includes(lastRow)) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    controller.abort()
    const rows = [...text.matchAll(/event: row\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]))
    expect(rows).toEqual(want)
    expectBounded()
  })
})

describe('follow from the projection: an old row it must load', () => {
  // A late answer for the conversation's FIRST tool call: its row is in a sealed page.
  const firstTool = events.find((e) => e.kind === 'tool-call') as { id: string }
  const late = {
    kind: 'tool-result',
    toolUseId: firstTool.id,
    isError: false,
    rawContent: 'late answer',
    structured: null
  } as AgentEvent

  beforeEach(() => {
    fake.reset()
    fake.buffer = history.map((e) => ({ ...e }))
    fake.projection = true
    fake.pageBytes = PAGE
    fake.watchers.clear()
  })

  /** The follow stream's text until `done` holds (or 8 s). */
  async function follow(during: () => Promise<void>, done: (text: string) => boolean) {
    const controller = new AbortController()
    const res = await fetch(`${rest.url}/api/chat/${chatTask}/follow`, {
      signal: controller.signal
    })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let ended = false
    const reading = (async () => {
      for (;;) {
        const { value, done: end } = await reader
          .read()
          .catch(() => ({ value: undefined, done: true }))
        if (end) {
          ended = true
          return
        }
        text += decoder.decode(value, { stream: true })
      }
    })()
    await new Promise((r) => setTimeout(r, 100))
    // This stream watches the tab (full events reach it): a previous test's stream
    // closing late must not take that watch away.
    fake.watchers.set(chatTask, 1)
    await during()
    const deadline = Date.now() + 8000
    while (!done(text) && !ended && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await reading
    return { text, ended: ended && !done(text) }
  }

  test('the projection moved on while loading it: the stream reopens and goes on', async () => {
    const { text, ended } = await follow(
      async () => {
        fake.expirePages = 1
        fake.emit(chatTask, late, history.length)
        await new Promise((r) => setTimeout(r, 200))
        fake.emit(
          chatTask,
          { kind: 'assistant-text', messageId: 'after', text: 'still following' } as AgentEvent,
          history.length + 1
        )
      },
      (t) => t.includes('still following')
    )
    expect(ended).toBe(false)
    expect(text).toContain('still following')
  })

  test('a state change after an event that waits for a row is sent after that event’s rows', async () => {
    const { text } = await follow(
      async () => {
        fake.pagesDelayMs = 300
        fake.emit(chatTask, late, history.length)
        fake.emit(
          chatTask,
          { kind: 'assistant-text', messageId: 'next', text: 'the next reply' } as AgentEvent,
          history.length + 1
        )
        fake.state(`${chatTask}:${chatTask}`, 'idle')
      },
      (t) => t.includes('event: state') && t.includes('the next reply')
    )
    expect(text, text).toContain('the next reply')
    expect(text.indexOf('the next reply')).toBeLessThan(text.indexOf('event: state'))
  })
})
