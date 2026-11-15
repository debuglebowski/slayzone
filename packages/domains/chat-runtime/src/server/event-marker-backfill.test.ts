/**
 * Event-marker backfill (FU5): conversations saved before `event_markers` existed are
 * indexed in the background — small slices with a pause between them (the computer's
 * event loop never stalls on it), checkpointed per conversation, covered only once
 * their last row is indexed, chats a summary is waiting on first.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { createEventMarkerBackfill, EVENT_MARKER_BACKFILL } from './event-marker-backfill'
import { createLocalPrompts } from './prompts'
import { openChatStorage } from './storage'

const roots: string[] = []
const stores: Array<ReturnType<typeof openChatStorage>> = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function open(dir = realpathSync(mkdtempSync(join(tmpdir(), 'slz-marker-bf-')))) {
  if (!roots.includes(dir)) roots.push(dir)
  const s = openChatStorage({ stateDir: dir, hubScope: 'hub' })
  stores.push(s)
  return { store: s, dir }
}
type Store = ReturnType<typeof open>['store']

/** A conversation as saved by a build before markers: rows, no markers, not covered. */
function legacyConversation(store: Store, id: string, events: number, taskId = 't') {
  store.createConversation({ id, taskId, tabId: id, mode: 'claude-chat', epoch: 1 })
  store.transaction(() => {
    for (let n = 0; n < events; n++)
      store.append(
        id,
        1,
        (n % 10 === 0
          ? { kind: 'turn-init', sessionId: `${id}-native`, model: 'm', cwd: '/', tools: [] }
          : n % 10 === 1
            ? { kind: 'user-message', id: `${id}-m${n}`, text: `prompt ${n}` }
            : {
                kind: 'tool-result',
                id: `r${n}`,
                output: 'o'.repeat(500)
              }) as unknown as AgentEvent,
        n
      )
  })
  store.compose((raw) => {
    raw.prepare('DELETE FROM event_markers WHERE conversation_id=?').run(id)
    raw.prepare('DELETE FROM event_marker_coverage WHERE conversation_id=?').run(id)
  })
}
const markerCount = (store: Store, id: string) =>
  store.compose(
    (raw) =>
      (
        raw.prepare('SELECT count(*) AS n FROM event_markers WHERE conversation_id=?').get(id) as {
          n: number
        }
      ).n
  )

/** A backfill on a manual clock: each `sleep` is a recorded pause, each slice ~1 row-read. */
function backfill(
  store: Store,
  over: Partial<Parameters<typeof createEventMarkerBackfill>[0]> = {}
) {
  const pauses: number[] = []
  const lines: string[] = []
  const bf = createEventMarkerBackfill({
    storage: store,
    automatic: false,
    log: (l) => lines.push(l),
    sleep: async (ms) => {
      pauses.push(ms)
    },
    sliceBytes: 4 * 1024,
    // One transaction per slice: every slice ends in a recorded pause.
    sliceMs: 0,
    ...over
  })
  return { bf, pauses, lines }
}

describe('event-marker backfill', () => {
  test('indexes every legacy conversation in bounded slices with pauses, then covers it', async () => {
    const { store } = open()
    legacyConversation(store, 'a', 200)
    legacyConversation(store, 'b', 50)
    expect(store.uncoveredMarkerConversations()).toEqual(['a', 'b'])
    const { bf, pauses, lines } = backfill(store)
    const report = await bf.runNow()
    expect(report).toMatchObject({ conversations: 2, markers: 50 })
    expect(markerCount(store, 'a')).toBe(40)
    expect(markerCount(store, 'b')).toBe(10)
    expect(store.uncoveredMarkerConversations()).toEqual([])
    // ~130 KB of rows in 4 KB slices: many pauses, never one long block.
    expect(pauses.length).toBeGreaterThan(20)
    expect(lines.some((l) => l.includes('[event-marker-backfill] complete'))).toBe(true)
    expect(await bf.runNow()).toBeNull()
    await bf.close()
  })

  test('the summary of a backfilled conversation equals its full-scan summary', async () => {
    const { store } = open()
    legacyConversation(store, 'a', 120)
    const prompts = createLocalPrompts(store)
    const scanned = prompts.summaries('t', ['a-native'])
    const { bf } = backfill(store)
    await bf.runNow()
    expect(prompts.summaries('t', ['a-native'])).toEqual(scanned)
    expect(scanned).toEqual([
      { conversationId: 'a-native', count: 12, firstPrompt: 'prompt 1', firstAt: 1 }
    ])
    await bf.close()
  })

  test('resumes from its checkpoint after a stop, without redoing covered work', async () => {
    const { store, dir } = open()
    legacyConversation(store, 'a', 300)
    let slices = 0
    const first = backfill(store, {
      sleep: async () => {
        // Not awaited: close() waits for this very pass.
        if (++slices === 5) void first.bf.close()
      }
    })
    await first.bf.runNow()
    const partial = markerCount(store, 'a')
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(60)
    expect(store.maintenanceCursor<number>(`${EVENT_MARKER_BACKFILL}:a`)).toBeGreaterThan(0)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = open(dir).store
    expect(reopened.uncoveredMarkerConversations()).toEqual(['a'])
    const second = backfill(reopened)
    const report = await second.bf.runNow()
    expect(markerCount(reopened, 'a')).toBe(60)
    expect(report!.markers).toBe(60 - partial)
    expect(reopened.maintenanceCursor(`${EVENT_MARKER_BACKFILL}:a`)).toBeNull()
    await second.bf.close()
  })

  test('appends and deletes while a conversation is being indexed leave its markers exact', async () => {
    const { store } = open()
    legacyConversation(store, 'a', 200)
    let n = 0
    const { bf } = backfill(store, {
      sleep: async () => {
        n++
        if (n === 3)
          store.append(
            'a',
            1,
            { kind: 'user-message', id: 'live', text: 'typed now' } as unknown as AgentEvent,
            500
          )
        if (n === 4)
          store.compose((raw) =>
            raw.prepare("DELETE FROM events WHERE conversation_id='a' AND seq=1").run()
          )
      }
    })
    await bf.runNow()
    const expected = store.compose(
      (raw) =>
        (
          raw
            .prepare(
              `SELECT count(*) AS n FROM events WHERE conversation_id='a'
                AND json_extract(event,'$.kind') IN ('turn-init','conversation-branch','user-message')`
            )
            .get() as { n: number }
        ).n
    )
    expect(markerCount(store, 'a')).toBe(expected)
    expect(store.uncoveredMarkerConversations()).toEqual([])
    await bf.close()
  })

  test('a conversation a summary is waiting on goes first', async () => {
    const { store } = open()
    legacyConversation(store, 'a', 40, 'other')
    legacyConversation(store, 'b', 40)
    const order: string[] = []
    const { bf } = backfill(store, {
      log: (line) => {
        const m = /indexed (\S+)/.exec(line)
        if (m) order.push(m[1]!)
      }
    })
    const prompts = createLocalPrompts(store, { uncovered: (ids) => bf.prioritize(ids) })
    prompts.summaries('t', ['b-native'])
    await bf.runNow()
    expect(order).toEqual(['b', 'a'])
    await bf.close()
  })

  test('deleted conversations are not indexed; close() ends a pass in its next pause', async () => {
    const { store } = open()
    legacyConversation(store, 'a', 20)
    store.compose((raw) =>
      raw.prepare("UPDATE conversations SET state='deleted' WHERE id='a'").run()
    )
    expect(store.uncoveredMarkerConversations()).toEqual([])
    const { bf } = backfill(store)
    expect(await bf.runNow()).toBeNull()
    await bf.close()
  })

  test('a conversation that keeps failing is skipped for the rest of the pass, the others indexed (review R5)', async () => {
    const { store } = open()
    legacyConversation(store, 'a', 30)
    legacyConversation(store, 'b', 30)
    const failing = new Proxy(store, {
      get(target, key, receiver) {
        if (key === 'backfillEventMarkers')
          return (id: string, ...rest: unknown[]) => {
            if (id === 'a') throw new Error('disk I/O error')
            return (target.backfillEventMarkers as (...a: unknown[]) => unknown)(id, ...rest)
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const { bf, lines } = backfill(failing)
    const report = await bf.runNow()
    expect(report).toMatchObject({ conversations: 1, failed: 1 })
    expect(store.uncoveredMarkerConversations()).toEqual(['a'])
    expect(lines.some((l) => /1 failed/.test(l))).toBe(true)
    await bf.close()
  })

  test('one pass reads the uncovered list once, not once per conversation (review R6)', async () => {
    const { store } = open()
    for (const id of ['a', 'b', 'c', 'd', 'e']) legacyConversation(store, id, 10)
    let reads = 0
    const counting = new Proxy(store, {
      get(target, key, receiver) {
        if (key === 'uncoveredMarkerConversations')
          return () => {
            reads++
            return target.uncoveredMarkerConversations()
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const { bf } = backfill(counting)
    await bf.runNow()
    expect(store.uncoveredMarkerConversations()).toEqual([])
    // Start, the one re-query when the list ran out, and the final verdict.
    expect(reads).toBeLessThanOrEqual(3)
    await bf.close()
  })
})
