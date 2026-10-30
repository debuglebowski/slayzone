/**
 * A checkpoint is a reducer state as text: everything but the rows before
 * `tailFrom` (those live in pages). Decoded and fed the rest of the events, it
 * must end exactly where a full replay ends — for both providers, from any
 * point. And a reducer change must change the version (old checkpoints are
 * then thrown away, never read by a reducer that would read them differently).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { buildLongSession } from '@slayzone/test-utils/chat-long-session'
import { initialState, reducer, type ChatTimelineState, type TimelineItem } from './chat-timeline'
import {
  CHAT_TIMELINE_VERSION,
  REDUCER_SOURCES,
  decodeTimelineState,
  encodeTimelineState
} from './chat-timeline-checkpoint'

const recorded = JSON.parse(
  readFileSync(new URL('./chat-timeline-version.json', import.meta.url), 'utf8')
) as { version: string; sha: string }

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] })
})
afterAll(() => {
  vi.useRealTimers()
})

/** Compares meaning, not the indexes' internal layout. */
function meaning(state: ChatTimelineState): unknown {
  return JSON.parse(
    JSON.stringify(state, (_k, v: unknown) => {
      if (v instanceof Map) return { $map: [...v.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) }
      if (
        v &&
        typeof v === 'object' &&
        'entries' in v &&
        !Array.isArray(v) &&
        !(v instanceof Map)
      ) {
        const idx = v as { entries(): Iterable<[string, unknown]> }
        return { $index: [...idx.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) }
      }
      return v
    })
  )
}

const sessions: Array<{ name: string; events: AgentEvent[]; agentStartedTurns: boolean }> = [
  { name: 'claude', events: buildLongSession({ events: 4_000, seed: 3 }), agentStartedTurns: true },
  {
    name: 'claude asked',
    events: buildLongSession({ events: 3_000, seed: 4, askEveryTool: true }),
    agentStartedTurns: true
  },
  {
    name: 'codex',
    events: buildLongSession({ events: 4_000, seed: 3, provider: 'codex' }),
    agentStartedTurns: false
  }
]

describe('checkpoint', () => {
  test('decoded at any point and fed the rest, it ends where a full replay ends', () => {
    for (const s of sessions) {
      const full = reducer(initialState({ agentStartedTurns: s.agentStartedTurns }), {
        type: 'events',
        events: s.events
      })
      for (const cut of [1, 500, 1_777, s.events.length - 10]) {
        const head = reducer(initialState({ agentStartedTurns: s.agentStartedTurns }), {
          type: 'events',
          events: s.events.slice(0, cut)
        })
        const tailFrom = Math.max(0, head.timeline.length - 300)
        const text = encodeTimelineState(head, tailFrom)
        const back = decodeTimelineState(text)
        expect(back.timeline.length).toBe(head.timeline.length)
        expect(back.timeline.slice(0, tailFrom).every((r) => r === undefined)).toBe(true)
        expect(back.timeline.slice(tailFrom)).toEqual(head.timeline.slice(tailFrom))
        // The rows before `tailFrom` come from pages: give them back, go on.
        let next = reducer(back, {
          type: 'rows-loaded',
          from: 0,
          rows: head.timeline.slice(0, tailFrom) as TimelineItem[],
          epoch: back.rowsEpoch
        })
        next = reducer(next, { type: 'events', events: s.events.slice(cut) })
        expect(meaning(next), `${s.name} cut ${cut}`).toEqual(meaning(full))
      }
    }
  })

  test('the text holds no row before tailFrom (they are in pages)', () => {
    const head = reducer(initialState(), { type: 'events', events: sessions[0].events })
    const text = encodeTimelineState(head, head.timeline.length - 5)
    const firstRowText = JSON.stringify(head.timeline[0])
    expect(text.includes(firstRowText)).toBe(false)
    expect(text.length).toBeLessThan(JSON.stringify(head.timeline).length / 4)
  })

  test('a stalled state is never a checkpoint', () => {
    const s = { ...initialState(), stalled: { need: 0, queue: [] } }
    expect(() => encodeTimelineState(s, 0)).toThrow(/stalled/)
  })

  test('text from another version, or unreadable text, is refused (the caller rebuilds)', () => {
    const text = encodeTimelineState(initialState(), 0)
    expect(() =>
      decodeTimelineState(text.replace(`"v":"${CHAT_TIMELINE_VERSION}"`, '"v":"0.0"'))
    ).toThrow(/version/)
    expect(() => decodeTimelineState('{not json')).toThrow()
  })
})

describe('reducer version', () => {
  test('the reducer sources hash to what this version recorded (changed them? bump the version)', () => {
    const hash = createHash('sha256')
    for (const path of REDUCER_SOURCES) hash.update(readFileSync(new URL(path, import.meta.url)))
    const sha = hash.digest('hex')
    expect(
      { version: CHAT_TIMELINE_VERSION, sha },
      'The chat reducer or what it calls changed. Saved timeline checkpoints would be read by a ' +
        'reducer that may build different rows: bump CHAT_TIMELINE_VERSION in ' +
        'chat-timeline-checkpoint.ts and record the new { version, sha } in chat-timeline-version.json.'
    ).toEqual(recorded)
  })

  test('every function the reducer imports from the contracts is in a hashed source', () => {
    const contractSources = REDUCER_SOURCES.filter((p) => p.includes('terminal-contracts'))
      .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
      .join('\n')
    for (const path of REDUCER_SOURCES.filter((p) => !p.includes('terminal-contracts'))) {
      const src = readFileSync(new URL(path, import.meta.url), 'utf8')
      for (const m of src.matchAll(/import \{([^}]*)\} from '@slayzone\/terminal-contracts'/g)) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim()
          if (!name || name.startsWith('type ')) continue
          expect(
            new RegExp(`export (function|const) ${name}\\b`).test(contractSources),
            `${path} imports ${name}: add its file to REDUCER_SOURCES`
          ).toBe(true)
        }
      }
      // And nothing from another workspace package with values in it.
      for (const m of src.matchAll(/^import \{[^}]*\} from '(@slayzone\/[^']+)'/gm)) {
        expect(m[1], `${path}: a value import the version hash does not cover`).toBe(
          '@slayzone/terminal-contracts'
        )
      }
    }
  })
})
