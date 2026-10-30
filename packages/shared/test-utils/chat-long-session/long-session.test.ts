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

  describe('codex', () => {
    it('is exactly the asked number of events, ending on a whole turn', () => {
      for (const n of [LONG_SESSION_EVENTS, 1_000, 37]) {
        const events = buildLongSession({ events: n, provider: 'codex' })
        expect(events).toHaveLength(n)
        expect(events.at(-1)?.kind).toBe('result')
      }
    })

    it('keeps the claude session unchanged (its shape feeds e2e fixtures and budgets)', () => {
      expect(JSON.stringify(buildLongSession({ events: 2_000, seed: 3, provider: 'claude' }))).toBe(
        JSON.stringify(buildLongSession({ events: 2_000, seed: 3 }))
      )
    })

    it('has the shapes the codex driver saves: one handshake turn-init, its tool names, deliveries, plans', () => {
      const events = buildLongSession({ events: 5_000, provider: 'codex' })
      expect(events.filter((e) => e.kind === 'turn-init')).toHaveLength(1)
      const names = new Set(events.flatMap((e) => (e.kind === 'tool-call' ? [e.name] : [])))
      expect([...names].sort()).toEqual(['codex/commandExecution', 'codex/fileChange'])
      const kinds = new Set(events.map((e) => e.kind))
      for (const k of [
        'user-message-delivery',
        'agent-plan',
        'assistant-text',
        'tool-result',
        'context-usage'
      ])
        expect(kinds.has(k as never)).toBe(true)
      // Every message is answered: delivered, then answered before its result.
      const delivered = events.flatMap((e) =>
        e.kind === 'user-message-delivery' && e.state === 'answered' ? [e.id] : []
      )
      const sent = events.flatMap((e) => (e.kind === 'user-message' && e.id ? [e.id] : []))
      expect(delivered).toEqual(sent.slice(0, delivered.length))
      expect(sent.length - delivered.length).toBeLessThanOrEqual(1)
    })
  })

  it('askEveryTool: every call is asked, 9 in 10 answered by a resolution', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const events = buildLongSession({ events: 3_000, provider, askEveryTool: true })
      expect(events).toHaveLength(3_000)
      const calls = events.filter((e) => e.kind === 'tool-call').length
      const asks = events.filter((e) => e.kind === 'permission-request').length
      const resolved = events.filter((e) => e.kind === 'permission-resolved').length
      expect(asks).toBeGreaterThanOrEqual(calls - 1)
      expect(resolved / asks).toBeGreaterThan(0.85)
      expect(resolved / asks).toBeLessThan(0.95)
    }
  })
})
