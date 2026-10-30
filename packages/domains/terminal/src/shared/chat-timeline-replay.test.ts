/**
 * Replay guards: a batch of events (`{ type: 'events' }`, how a tab opens a
 * saved session) builds EXACTLY the state the same events build one by one (the
 * live path), for every recorded Claude and Codex fixture and long generated
 * sessions of both providers; a batch never changes the state it starts from;
 * and a batch costs time linear in its length.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { buildLongSession } from '@slayzone/test-utils/chat-long-session'
import { claudeChatBackend } from '../server/agents/claude-session-driver'
import { codexChatBackend } from '../server/agents/codex/codex-chat-session'
import type { ChatDriverContext } from '../server/agents/types'
import { initialState, reducer, replayIndexProblems, type ChatTimelineState } from './chat-timeline'
import { copiedSlotCount } from './replay-batch'
import type { TimelineRows } from './timeline-rows'
import type { TimelineItem } from './chat-timeline'

/** A full state holds every row: its timeline as plain items. */
const rowsOf = (s: { timeline: ReadonlyArray<TimelineItem | undefined> }): TimelineItem[] =>
  s.timeline as TimelineItem[]

const CLAUDE_DIR = new URL('../../test/fixtures/claude-stream/', import.meta.url)
const CODEX_FIXTURE = new URL(
  '../../test/fixtures/codex-app-server/simple-turn.ndjson',
  import.meta.url
)

const driverCtx = (emit: (e: AgentEvent) => void): ChatDriverContext => ({
  write: () => undefined,
  emit,
  cwd: '/tmp',
  sessionId: 'replay',
  resume: false,
  providerFlags: [],
  chatModel: null,
  chatEffort: null,
  chatMode: null,
  chatCollaboration: null,
  chatFastMode: false
})

/** A recorded Claude stream as the app receives it (the session driver's events). */
function claudeFixture(name: string): AgentEvent[] {
  const events: AgentEvent[] = []
  const driver = claudeChatBackend.createDriver()
  void driver.start(driverCtx((e) => events.push(e)))
  for (const line of readFileSync(new URL(name, CLAUDE_DIR), 'utf8').split('\n'))
    if (line.trim()) driver.handleLine(line)
  driver.dispose()
  return events
}

/** The recorded Codex app-server turn, through the Codex driver (handshake answered). */
async function codexFixture(): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  const driver = codexChatBackend.createDriver()
  void driver.start(driverCtx((e) => events.push(e)))
  const tick = () => new Promise((r) => setTimeout(r, 0))
  await tick()
  driver.handleLine(JSON.stringify({ id: 1, result: { userAgent: 'x', codexHome: '/h' } }))
  await tick()
  driver.handleLine(
    JSON.stringify({ id: 2, result: { thread: { id: 'thread-1' }, model: 'gpt-5.5', cwd: '/w' } })
  )
  await tick()
  for (const line of readFileSync(CODEX_FIXTURE, 'utf8').split('\n')) {
    if (line.includes('"method"')) driver.handleLine(line)
  }
  await tick()
  driver.dispose()
  return events
}

const fresh = (agentStartedTurns: boolean) => initialState({ agentStartedTurns })

function oneByOne(events: AgentEvent[], start: ChatTimelineState): ChatTimelineState {
  let s = start
  for (const event of events) s = reducer(s, { type: 'event', event })
  return s
}

/** The same events in batches of irregular sizes (a frame's worth each, say). */
function inChunks(events: AgentEvent[], start: ChatTimelineState, seed: number): ChatTimelineState {
  let s = start
  let a = seed
  for (let i = 0; i < events.length; ) {
    a = (a * 1103515245 + 12345) % 2147483648
    const n = 1 + (a % 97)
    s = reducer(s, { type: 'events', events: events.slice(i, i + n) })
    i += n
  }
  return s
}

/** Everything a state holds, comparable and printable (Maps and Sets as entries). */
function snapshot(state: ChatTimelineState): unknown {
  return JSON.parse(
    JSON.stringify(state, (_k, v: unknown) => {
      if (v instanceof Map) return { $map: [...v.entries()] }
      if (v instanceof Set) return { $set: [...v] }
      return v
    })
  )
}

function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const v of Object.values(value)) deepFreeze(v, seen)
  if (value instanceof Map) for (const v of value.values()) deepFreeze(v, seen)
  return Object.freeze(value)
}

interface Session {
  name: string
  events: AgentEvent[]
  agentStartedTurns: boolean
}
const sessions: Session[] = []

beforeAll(async () => {
  // Rows carry wall-clock times: one fixed clock makes the paths comparable.
  vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] })
  for (const f of readdirSync(CLAUDE_DIR)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()) {
    sessions.push({ name: `claude ${f}`, events: claudeFixture(f), agentStartedTurns: true })
  }
  sessions.push({
    name: 'codex simple-turn',
    events: await codexFixture(),
    agentStartedTurns: false
  })
  sessions.push({
    name: 'claude long 6k',
    events: buildLongSession({ events: 6_000, seed: 5 }),
    agentStartedTurns: true
  })
  sessions.push({
    name: 'claude long 3k, asked for every tool',
    events: buildLongSession({ events: 3_000, seed: 6, askEveryTool: true }),
    agentStartedTurns: true
  })
  sessions.push({
    name: 'codex long 3k, asked for every tool',
    events: buildLongSession({ events: 3_000, seed: 6, provider: 'codex', askEveryTool: true }),
    agentStartedTurns: false
  })
  sessions.push({
    name: 'codex long 6k',
    events: buildLongSession({ events: 6_000, seed: 5, provider: 'codex' }),
    agentStartedTurns: false
  })
})
afterAll(() => {
  vi.useRealTimers()
})

describe('replay: one batch = the same events one by one', () => {
  test('every fixture and long session, both providers', () => {
    expect(sessions.length).toBeGreaterThan(20)
    for (const s of sessions) {
      const live = oneByOne(s.events, fresh(s.agentStartedTurns))
      const batch = reducer(fresh(s.agentStartedTurns), { type: 'events', events: s.events })
      expect(snapshot(batch), s.name).toEqual(snapshot(live))
      expect(snapshot(inChunks(s.events, fresh(s.agentStartedTurns), 7)), s.name).toEqual(
        snapshot(live)
      )
    }
  })

  test('a batch that starts mid-session (live state behind it) ends the same', () => {
    for (const s of sessions) {
      const cut = Math.floor(s.events.length / 2)
      const head = oneByOne(s.events.slice(0, cut), fresh(s.agentStartedTurns))
      const live = oneByOne(s.events.slice(cut), head)
      const batch = reducer(head, { type: 'events', events: s.events.slice(cut) })
      expect(snapshot(batch), s.name).toEqual(snapshot(live))
    }
  })
})

describe('replay: indexes find what a scan of the rows finds', () => {
  // The reducer looks rows up through indexes (user message by id, a block's
  // ordinal in its turn) instead of scanning the timeline: after EVERY event
  // they must equal the scan.
  test('after every event of every session', () => {
    for (const s of sessions) {
      let state = fresh(s.agentStartedTurns)
      for (const [i, event] of s.events.entries()) {
        state = reducer(state, { type: 'event', event })
        const problems = replayIndexProblems(state)
        if (problems.length)
          expect(problems, `${s.name} after event ${i} (${event.kind})`).toEqual([])
      }
    }
  })

  test('renderer actions keep them too (optimistic sends, failures, retries, pops)', () => {
    let state = fresh(true)
    const steps: Parameters<typeof reducer>[1][] = [
      { type: 'user-sent', text: 'legacy, no id' },
      { type: 'user-sent', id: 'a', text: 'with id' },
      { type: 'event', event: { kind: 'user-message', text: 'legacy, no id' } },
      { type: 'user-send-failed', id: 'a', error: 'x' },
      { type: 'user-retry', id: 'a' },
      { type: 'event', event: { kind: 'user-message', id: 'a', text: 'with id' } },
      {
        type: 'event',
        event: { kind: 'turn-init', sessionId: 's', model: 'm', cwd: '/', tools: [] }
      },
      { type: 'user-sent', id: 'b', text: 'popped' },
      { type: 'event', event: { kind: 'user-message', id: 'b', text: 'popped' } },
      { type: 'event', event: { kind: 'user-message-popped', id: 'b', text: 'popped' } },
      { type: 'user-sent', text: 'legacy fails' },
      { type: 'user-send-failed' },
      { type: 'reset' }
    ]
    for (const [i, action] of steps.entries()) {
      state = reducer(state, action)
      expect(replayIndexProblems(state), `step ${i} (${action.type})`).toEqual([])
    }
  })
})

describe('replay: a batch never changes the state it starts from', () => {
  test('frozen start state, unchanged after the batch', () => {
    for (const s of sessions) {
      const cut = Math.floor(s.events.length / 3)
      const head = oneByOne(s.events.slice(0, cut), fresh(s.agentStartedTurns))
      const before = JSON.stringify(snapshot(head))
      deepFreeze(head)
      // Frozen arrays/objects throw on write (ESM is strict); Maps are compared below.
      reducer(head, { type: 'events', events: s.events.slice(cut) })
      expect(JSON.stringify(snapshot(head)), s.name).toBe(before)
    }
  })

  test('a state from the middle of a batch is never reused: two batches from one start agree', () => {
    for (const s of sessions) {
      const start = fresh(s.agentStartedTurns)
      const a = reducer(start, { type: 'events', events: s.events })
      const b = reducer(start, { type: 'events', events: s.events })
      expect(a.timeline).not.toBe(b.timeline)
      expect(snapshot(a), s.name).toEqual(snapshot(b))
    }
  })
})

describe('replay: one batch is linear in its length', () => {
  // Deterministic: count what the batch copies (array elements, Map entries).
  // Copying the timeline per row, as the reducer used to, is ~rows²/2; a batch
  // copies each container at most once. (Wall-clock linearity at 10k–100k is
  // checked by the perf budget, `pnpm test:chat:perf`.)
  const copiesOf = (events: AgentEvent[], agentStartedTurns: boolean): number => {
    const before = copiedSlotCount()
    reducer(fresh(agentStartedTurns), { type: 'events', events })
    return copiedSlotCount() - before
  }

  test.each([
    ['claude', true, false],
    ['codex', false, false],
    ['claude, asked for every tool', true, true],
    ['codex, asked for every tool', false, true]
  ] as const)('%s: copies stay under the events count', (name, agentStartedTurns, ask) => {
    const provider = name.startsWith('codex') ? 'codex' : 'claude'
    const events = buildLongSession({ events: 20_000, seed: 2, provider, askEveryTool: ask })
    expect(copiesOf(events, agentStartedTurns)).toBeLessThan(events.length)
  })

  // An autonomous run: ONE turn of thousands of replies and tool calls.
  test('one very long turn: copies stay under the events count', () => {
    const out: AgentEvent[] = [
      { kind: 'user-message', id: 'u0', text: 'go' },
      { kind: 'turn-init', sessionId: 's', model: 'm', cwd: '/r', tools: [] }
    ]
    for (let i = 0; i < 6_000; i++) {
      out.push(
        { kind: 'assistant-text', messageId: `m${i}`, text: `step ${i}` },
        { kind: 'tool-call', id: `t${i}`, name: 'Bash', input: { command: 'ls' } },
        {
          kind: 'tool-result',
          toolUseId: `t${i}`,
          isError: false,
          rawContent: 'ok',
          structured: null
        }
      )
    }
    out.push(buildLongSession({ events: 3 }).at(-1)!)
    expect(copiesOf(out, true)).toBeLessThan(out.length)
  })

  test('one by one, each event copies at most what it changes (the old shape: rows per event)', () => {
    // The live path: one event, one copy of the timeline at most — not several.
    const events = buildLongSession({ events: 2_000, seed: 3 })
    let state = fresh(true)
    for (const event of events) {
      const rows = state.timeline.length
      const before = copiedSlotCount()
      state = reducer(state, { type: 'event', event })
      // Its rows, an index path (~100), and once per index the growth past 64
      // keys into its trie (33 nodes of 32 slots) — never rows several times.
      expect(copiedSlotCount() - before).toBeLessThanOrEqual(rows + 2 * 33 * 32 + 512)
    }
  })
})

describe('replay: a row shows the time its event was saved', () => {
  test('one event, a batch, and the bg-shell spawn time — not the time of the replay', () => {
    const t0 = Date.UTC(2026, 0, 2, 3, 4, 5)
    const one = reducer(fresh(true), {
      type: 'event',
      event: { kind: 'user-message', id: 'u1', text: 'hi' },
      at: t0
    })
    expect(one.timeline[0]?.timestamp).toBe(t0)
    const events: AgentEvent[] = [
      { kind: 'user-message', id: 'u1', text: 'run it' },
      {
        kind: 'tool-call',
        id: 'b1',
        name: 'Bash',
        input: { command: 'sleep 9', run_in_background: true }
      },
      { kind: 'assistant-text', messageId: 'm1', text: 'ok' }
    ]
    const batch = reducer(fresh(true), { type: 'events', events, at: [t0, t0 + 1, t0 + 2] })
    expect(batch.timeline.map((r) => r?.timestamp)).toEqual([t0, t0 + 1, t0 + 2])
    expect(batch.bgShells.get('b1')?.spawnedAt).toBe(t0 + 1)
    // Without a time (a live-only event, a renderer action): now, as before.
    const live = reducer(fresh(true), { type: 'events', events: events.slice(0, 1) })
    expect(live.timeline[0]?.timestamp).toBe(Date.now())
  })
})

describe('paged: a state holding only some rows ends exactly where a full replay ends', () => {
  // Before every event some rows are unloaded (dropped); when the reducer needs
  // one it stalls, the rows come back (as of the same events — the "hub" is a
  // full replay kept in step) and it goes on. Every step must equal the full one.
  const prng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  test.each([0.02, 0.3])('every session, a page dropped before an event with p=%s', (p) => {
    let totalStalls = 0
    for (const s of sessions) {
      const rand = prng(11)
      let full = fresh(s.agentStartedTurns)
      let paged = fresh(s.agentStartedTurns)
      let stalls = 0
      let prevPaged: TimelineRows = []
      let prevFull: TimelineRows = []
      for (const [i, event] of s.events.entries()) {
        if (rand() < p && paged.timeline.length > 0) {
          const from = Math.floor(rand() * paged.timeline.length)
          paged = reducer(paged, {
            type: 'rows-unloaded',
            from,
            to: from + 1 + Math.floor(rand() * 40)
          })
        }
        paged = reducer(paged, { type: 'event', event })
        for (let guard = 0; paged.stalled && guard < 10_000; guard++) {
          stalls++
          const need = paged.stalled.need
          const from = Math.max(0, need - 8)
          paged = reducer(paged, {
            type: 'rows-loaded',
            from,
            rows: rowsOf(full).slice(from, need + 8),
            epoch: paged.rowsEpoch
          })
        }
        full = reducer(full, { type: 'event', event })
        expect(paged.stalled, `${s.name} event ${i}`).toBeNull()
        expect(paged.timeline.length).toBe(full.timeline.length)
        // Every row it holds is the full replay's row. Both copy on write: a
        // row neither side touched since the last event is the one already
        // compared, so only rows that changed (or appeared, or loaded) on
        // EITHER side are compared again — a change the paged side missed is
        // a full-side change.
        for (let at = 0; at < paged.timeline.length; at++) {
          const row = paged.timeline[at]
          if (row === undefined) continue
          if (row === prevPaged[at] && full.timeline[at] === prevFull[at]) continue
          expect(row, `${s.name} event ${i} row ${at}`).toEqual(full.timeline[at])
        }
        prevPaged = paged.timeline
        prevFull = full.timeline
      }
      const filled = reducer(paged, {
        type: 'rows-loaded',
        from: 0,
        rows: rowsOf(full),
        epoch: paged.rowsEpoch
      })
      const { timeline: _a, stalled: _b, ...pagedRest } = filled
      const { timeline: _c, stalled: _d, ...fullRest } = full
      expect(snapshot({ ...pagedRest, timeline: filled.timeline } as never), s.name).toEqual(
        snapshot({ ...fullRest, timeline: full.timeline } as never)
      )
      totalStalls += stalls
    }
    // The drops did make the reducer wait for rows (the path under test ran).
    expect(totalStalls).toBeGreaterThan(p > 0.1 ? 200 : 10)
  })

  test('actions that arrive while stalled wait, in order, behind the one that stalled', () => {
    const events = buildLongSession({ events: 400, seed: 9 })
    const full = reducer(fresh(true), { type: 'events', events: events.slice(0, 300) })
    // Everything unloaded: the next tool result for an old call must stall.
    let paged = reducer(full, { type: 'rows-unloaded', from: 0, to: full.timeline.length })
    paged = reducer(paged, { type: 'events', events: events.slice(300, 350) })
    paged = reducer(paged, { type: 'events', events: events.slice(350) })
    paged = reducer(paged, { type: 'user-sent', id: 'opt', text: 'typed meanwhile' })
    expect(paged.stalled?.queue.map((a) => a.type)).toEqual(['events', 'events', 'user-sent'])
    const done = reducer(paged, {
      type: 'rows-loaded',
      from: 0,
      rows: rowsOf(full),
      epoch: paged.rowsEpoch
    })
    const expected = reducer(reducer(full, { type: 'events', events: events.slice(300) }), {
      type: 'user-sent',
      id: 'opt',
      text: 'typed meanwhile'
    })
    expect(done.stalled).toBeNull()
    expect(snapshot(done)).toEqual(snapshot(expected))
  })

  test('rows asked for before the rows moved (another epoch) are not filled in', () => {
    const full = reducer(fresh(true), { type: 'events', events: buildLongSession({ events: 50 }) })
    const paged = reducer(full, { type: 'rows-unloaded', from: 0, to: 10 })
    const stale = reducer(paged, {
      type: 'rows-loaded',
      from: 0,
      rows: rowsOf(full),
      epoch: paged.rowsEpoch + 1
    })
    expect(stale.timeline.slice(0, 10).every((r) => r === undefined)).toBe(true)
  })
})
