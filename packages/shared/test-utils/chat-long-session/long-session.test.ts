import { describe, expect, it } from 'vitest'
import { LONG_SESSION_EVENTS, buildLongSession } from './index'

describe('buildLongSession', () => {
  it('is exactly the asked number of events, ending on a whole turn', () => {
    for (const n of [LONG_SESSION_EVENTS, 1_000, 37]) {
      const events = buildLongSession({ events: n })
      expect(events).toHaveLength(n)
      expect(events.at(-1)?.kind).toBe('result')
    }
  })

  it('is the same for the same seed, different for another', () => {
    const a = JSON.stringify(buildLongSession({ events: 2_000, seed: 7 }))
    expect(JSON.stringify(buildLongSession({ events: 2_000, seed: 7 }))).toBe(a)
    expect(JSON.stringify(buildLongSession({ events: 2_000, seed: 8 }))).not.toBe(a)
  })

  it('every call has one result, every id is unique, every message opens a turn its result closes', () => {
    const events = buildLongSession()
    const calls = new Set<string>()
    const results = new Set<string>()
    const messages = new Set<string>()
    let open = false
    for (const e of events) {
      if (e.kind === 'tool-call') {
        expect(calls.has(e.id)).toBe(false)
        calls.add(e.id)
      } else if (e.kind === 'tool-result') {
        expect(calls.has(e.toolUseId)).toBe(true)
        results.add(e.toolUseId)
      } else if (e.kind === 'assistant-text' || e.kind === 'assistant-thinking') {
        expect(messages.has(e.messageId)).toBe(false)
        messages.add(e.messageId)
        expect(open).toBe(true)
      } else if (e.kind === 'user-message') {
        expect(open).toBe(false)
        open = true
      } else if (e.kind === 'result') {
        open = false
      }
    }
    expect(results.size).toBe(calls.size)
    // A real mix, not one shape repeated.
    const names = new Set(events.flatMap((e) => (e.kind === 'tool-call' ? [e.name] : [])))
    expect([...names].sort()).toEqual(['Bash', 'Edit', 'Grep', 'Read', 'Task', 'TodoWrite'])
  })
})
