import { describe, expect, test } from 'vitest'
import {
  appendProviderConversationId,
  CONVERSATION_HISTORY_CAP,
  type ProviderConfig
} from './types'

const M = 'claude-code'
const hist = (cfg: ProviderConfig): string[] => cfg[M]?.conversationHistory ?? []

describe('appendProviderConversationId', () => {
  // Append to empty.
  test('append to null cfg seeds history', () => {
    expect(hist(appendProviderConversationId(null, M, 'a'))).toEqual(['a'])
  })

  // Most-recent-last ordering. The next three tests share `cfg` and run in
  // declaration order: each builds on the previous one's state.
  let cfg: ProviderConfig = {}
  test('appends most-recent-last', () => {
    cfg = appendProviderConversationId(cfg, M, 'a')
    cfg = appendProviderConversationId(cfg, M, 'b')
    cfg = appendProviderConversationId(cfg, M, 'c')
    expect(hist(cfg)).toEqual(['a', 'b', 'c'])
  })

  // Dedup: re-appending an existing id moves it to the end (no duplicate).
  test('re-append moves id to end, deduped', () => {
    cfg = appendProviderConversationId(cfg, M, 'a')
    expect(hist(cfg)).toEqual(['b', 'c', 'a'])
  })

  // Idempotent re-append of the current most-recent.
  test('re-append of last is a no-op', () => {
    cfg = appendProviderConversationId(cfg, M, 'a')
    expect(hist(cfg)).toEqual(['b', 'c', 'a'])
  })

  // Cap: never exceeds CONVERSATION_HISTORY_CAP, keeps the most recent.
  const cappedHist = (): string[] => {
    let capped: ProviderConfig = {}
    for (let i = 0; i < CONVERSATION_HISTORY_CAP + 5; i++) {
      capped = appendProviderConversationId(capped, M, `id-${i}`)
    }
    return hist(capped)
  }
  test('history capped at CONVERSATION_HISTORY_CAP', () => {
    expect(cappedHist()).toHaveLength(CONVERSATION_HISTORY_CAP)
  })
  test('cap keeps newest', () => {
    const h = cappedHist()
    expect(h[h.length - 1]).toBe(`id-${CONVERSATION_HISTORY_CAP + 4}`)
  })
  test('cap drops oldest', () => {
    expect(cappedHist()[0]).toBe(`id-5`)
  })

  // Preserves other fields of the mode entry.
  const withFlags: ProviderConfig = { [M]: { flags: '--x', conversationId: 'live' } }
  test('append preserves flags', () => {
    expect(appendProviderConversationId(withFlags, M, 'h1')[M]?.flags).toBe('--x')
  })
  test('append preserves conversationId', () => {
    expect(appendProviderConversationId(withFlags, M, 'h1')[M]?.conversationId).toBe('live')
  })

  // Does not disturb other modes.
  test('append leaves other modes untouched', () => {
    const multi: ProviderConfig = { codex: { conversationId: 'cx' } }
    const after2 = appendProviderConversationId(multi, M, 'h1')
    expect(after2.codex?.conversationId).toBe('cx')
  })
})
