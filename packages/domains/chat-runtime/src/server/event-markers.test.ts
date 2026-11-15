/**
 * Event markers (FU5 computer stalls): `prompts.summaries` read EVERY event of a task
 * (json_extract over each row — 76 MB / 24.8k rows for the dev store's biggest task)
 * to find the ~0.4 % that matter (`turn-init`, `conversation-branch`, `user-message`).
 * `event_markers` is a trigger-maintained index of exactly those rows;
 * `event_marker_coverage` names the conversations whose rows are all indexed (born
 * covered; older ones once the backfill reaches them). Uncovered conversations keep
 * today's scan, so a summary is the same whichever path serves it.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { createLocalPrompts, PROMPT_SUMMARY_ROWS_SQL, storePrompt } from './prompts'
import { openChatStorage } from './storage'

const roots: string[] = []
const stores: Array<ReturnType<typeof openChatStorage>> = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function open() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slz-markers-')))
  roots.push(dir)
  const s = openChatStorage({ stateDir: dir, hubScope: 'hub' })
  stores.push(s)
  return s
}
type Store = ReturnType<typeof open>

function conversation(store: Store, id: string, taskId: string) {
  store.createConversation({ id, taskId, tabId: id, mode: 'claude-chat', epoch: 1 })
}
const markers = (store: Store, id: string) =>
  store.compose((raw) =>
    raw
      .prepare(
        'SELECT seq, kind, session_id, branch_id, message_id FROM event_markers WHERE conversation_id=? ORDER BY seq'
      )
      .all(id)
  )
const covered = (store: Store, id: string) =>
  store.compose(
    (raw) => !!raw.prepare('SELECT 1 FROM event_marker_coverage WHERE conversation_id=?').get(id)
  )
/** As if the conversation's rows were saved by a build before markers existed. */
function forgetMarkers(store: Store, id: string) {
  store.compose((raw) => {
    raw.prepare('DELETE FROM event_markers WHERE conversation_id=?').run(id)
    raw.prepare('DELETE FROM event_marker_coverage WHERE conversation_id=?').run(id)
  })
}

describe('triggers keep the markers exact', () => {
  test('insert: only the three kinds, with the same values the old scan extracted', () => {
    const store = open()
    conversation(store, 'c', 't')
    expect(covered(store, 'c')).toBe(true)
    store.append(
      'c',
      1,
      { kind: 'user-message', id: 'm1', text: 'hello' } as unknown as AgentEvent,
      1
    )
    store.append(
      'c',
      1,
      { kind: 'tool-call', id: 'x', name: 'Read', input: {} } as unknown as AgentEvent,
      2
    )
    store.append(
      'c',
      1,
      {
        kind: 'turn-init',
        sessionId: 's1',
        model: 'm',
        cwd: '/',
        tools: []
      } as unknown as AgentEvent,
      3
    )
    store.append(
      'c',
      1,
      { kind: 'conversation-branch', conversationId: 'b1' } as unknown as AgentEvent,
      4
    )
    expect(markers(store, 'c')).toEqual([
      { seq: 0, kind: 'user-message', session_id: null, branch_id: null, message_id: 'm1' },
      { seq: 2, kind: 'turn-init', session_id: 's1', branch_id: null, message_id: null },
      { seq: 3, kind: 'conversation-branch', session_id: null, branch_id: 'b1', message_id: null }
    ])
  })

  test('delete (history cleared) drops markers; an invalid row never refuses the insert', () => {
    const store = open()
    conversation(store, 'c', 't')
    store.append(
      'c',
      1,
      { kind: 'user-message', id: 'm1', text: 'hello' } as unknown as AgentEvent,
      1
    )
    store.clearHistory('c', 1)
    expect(markers(store, 'c')).toEqual([])
    store.compose((raw) =>
      raw
        .prepare(
          "INSERT INTO events(conversation_id,seq,saved_at,event) VALUES('c',99,1,'{not json')"
        )
        .run()
    )
    expect(markers(store, 'c')).toEqual([])
  })

  test("an in-place rewrite of a legacy row (FU4 / crash-4 backfill's UPDATE OF event) re-derives its marker", () => {
    const store = open()
    conversation(store, 'c', 't')
    const legacy = JSON.stringify({ kind: 'user-message', id: 'm1', text: 'with image' })
    store.compose((raw) =>
      raw
        .prepare(
          "INSERT INTO events(conversation_id,seq,saved_at,event,blob_form) VALUES('c',0,1,?,0)"
        )
        .run(legacy)
    )
    const stored = { kind: 'user-message', id: 'm1', text: 'with image' } as unknown as AgentEvent
    expect(store.rewriteLegacyEvent('c', 1, 0, legacy, stored)).toBe(true)
    expect(markers(store, 'c')).toEqual([
      { seq: 0, kind: 'user-message', session_id: null, branch_id: null, message_id: 'm1' }
    ])
    // A rewrite that changed what the row is (never done; still exact).
    store.compose((raw) =>
      raw
        .prepare("UPDATE events SET event=? WHERE conversation_id='c' AND seq=0")
        .run(JSON.stringify({ kind: 'tool-result', id: 'r' }))
    )
    expect(markers(store, 'c')).toEqual([])
  })
})

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A task's chats with every shape the summary rules care about. */
function seedTask(store: Store, seed: number) {
  const r = rng(seed)
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!
  const sessions = ['s1', 's2', 's3', 'b1', 'b2']
  const texts = ['first', 'second', '  ', '', '__slay_control__', 'later', 'x'.repeat(50)]
  const ids: string[] = []
  for (const task of ['t', 'other']) {
    for (let c = 0; c < 3; c++) {
      const id = `${task}-c${c}`
      ids.push(id)
      conversation(store, id, task)
      let at = 1
      for (let n = 0; n < 60; n++) {
        const roll = r()
        const event: AgentEvent =
          roll < 0.35
            ? ({
                kind: 'user-message',
                id: r() < 0.2 ? 'dup' : `m${n}`,
                text: pick(texts),
                ...(r() < 0.1 ? { history: true } : {})
              } as unknown as AgentEvent)
            : roll < 0.45
              ? ({
                  kind: 'turn-init',
                  sessionId: pick(sessions),
                  model: 'm',
                  cwd: '/',
                  tools: []
                } as unknown as AgentEvent)
              : roll < 0.5
                ? ({
                    kind: 'conversation-branch',
                    conversationId: pick(sessions)
                  } as unknown as AgentEvent)
                : ({
                    kind: 'tool-result',
                    id: `r${n}`,
                    output: 'o'.repeat(200)
                  } as unknown as AgentEvent)
        store.append(id, 1, event, (at += Math.floor(r() * 3)))
      }
      if (r() < 0.5)
        store.putRecord(id, 1, {
          kind: 'settings',
          id: `session-anchor:${c}`,
          value: { seq: 30, sessionId: pick(sessions) },
          at: 5
        })
    }
    storePrompt(store, {
      id: `p-${task}`,
      taskId: task,
      agentId: 'claude-code',
      cliSessionId: 's1',
      text: 'captured',
      createdAt: 2
    })
  }
  return { ids, sessions }
}

describe('summaries: the same answer from markers as from the full scan', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`seed ${seed}: covered, uncovered and mixed conversations agree`, () => {
      const store = open()
      const { ids, sessions } = seedTask(store, seed)
      const prompts = createLocalPrompts(store)
      const viaMarkers = prompts.summaries('t', sessions)
      expect(viaMarkers.length).toBeGreaterThan(0)
      forgetMarkers(store, ids[0]!)
      const mixed = prompts.summaries('t', sessions)
      for (const id of ids) forgetMarkers(store, id)
      const viaScan = prompts.summaries('t', sessions)
      expect(mixed).toEqual(viaScan)
      expect(viaMarkers).toEqual(viaScan)
      // Every conversation of the task at once (`null`, FU5 S6) = asking for each.
      const byId = (rows: typeof viaScan) =>
        [...rows].sort((a, b) => a.conversationId.localeCompare(b.conversationId))
      expect(byId(prompts.summaries('t', null))).toEqual(byId(viaScan))
    })
  }

  test('a covered conversation reads its events by primary key only (no scan of its rows)', () => {
    const store = open()
    const plan = store
      .compose((raw) =>
        raw.prepare(`EXPLAIN QUERY PLAN ${PROMPT_SUMMARY_ROWS_SQL}`).all('t', 't', 't')
      )
      .map((r) => (r as { detail: string }).detail)
      .join('\n')
    expect(plan).toMatch(/SEARCH m USING PRIMARY KEY \(conversation_id=\?\)/)
    expect(plan).toMatch(
      /SEARCH e USING INDEX sqlite_autoindex_events_1 \(conversation_id=\? AND seq=\?\)/
    )
  })

  test('list(): one ownership lookup per conversation, not per prompt', () => {
    const store = open()
    for (let n = 0; n < 50; n++)
      storePrompt(store, {
        id: `p${n}`,
        taskId: 't',
        agentId: 'claude-code',
        cliSessionId: 's',
        text: `prompt ${n}`,
        createdAt: n
      })
    let lookups = 0
    const counting = new Proxy(store, {
      get(target, key, receiver) {
        if (key === 'conversation')
          return (id: string) => {
            lookups++
            return target.conversation(id)
          }
        return Reflect.get(target, key, receiver)
      }
    })
    expect(createLocalPrompts(counting).list('t')).toHaveLength(50)
    expect(lookups).toBe(1)
  })
})

describe('cost: summaries no longer scale with the task’s event bytes', () => {
  test('25k events / ~40 MB, 100 markers: covered ≪ full scan (measured)', () => {
    const store = open()
    conversation(store, 'big', 't')
    const payload = 'z'.repeat(1_600)
    store.transaction(() => {
      for (let n = 0; n < 25_000; n++)
        store.append(
          'big',
          1,
          (n % 250 === 0
            ? { kind: 'turn-init', sessionId: 'native', model: 'm', cwd: '/', tools: [] }
            : n % 250 === 1
              ? { kind: 'user-message', id: `m${n}`, text: `prompt ${n}` }
              : { kind: 'tool-result', id: `r${n}`, output: payload }) as unknown as AgentEvent,
          n
        )
    })
    const prompts = createLocalPrompts(store)
    const time = () => {
      const t0 = performance.now()
      const out = prompts.summaries('t', ['native'])
      return { ms: performance.now() - t0, out }
    }
    time() // warm the page cache for both runs alike
    const markers = time()
    forgetMarkers(store, 'big')
    const scan = time()
    console.log(
      `[fu5] summaries 25k events: markers ${markers.ms.toFixed(1)} ms, full scan ${scan.ms.toFixed(1)} ms`
    )
    expect(markers.out).toEqual(scan.out)
    expect(markers.out).toEqual([
      { conversationId: 'native', count: 100, firstPrompt: 'prompt 1', firstAt: 1 }
    ])
    expect(markers.ms * 5).toBeLessThan(scan.ms)
  })
})
