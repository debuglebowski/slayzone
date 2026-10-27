/**
 * Unit tests for resolveSpawnConversation — the fresh-vs-resume invariant that
 * guards the restart-clobber regression: a known conversation (renderer hint OR
 * ledger-resolved by main) must RESUME, never fresh-mint over it.
 */
import { describe, expect, test } from 'vitest'
import { resolveSpawnConversation } from './spawn-conversation'

// 1. THE regression guard: ledger id present, renderer hint absent → RESUME, no mint.
//    This is exactly the restart-clobber: boot board store hadn't hydrated the
//    hint, but main resolves the real id from the ledger.
describe('1. THE regression guard: ledger id present, renderer hint absent → RESUME, no mint', () => {
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: 'REAL',
    conversationId: null,
    supportsFreshPreMint: true
  })
  test('ledger id resolves when hint absent', () => {
    expect(d.resolvedExistingId).toBe('REAL')
  })
  test('resuming when ledger id present', () => {
    expect(d.resuming).toBe(true)
  })
  test('must NOT mint fresh over a known ledger conversation', () => {
    expect(d.shouldMintFresh).toBe(false)
  })
})

// 2. Nothing known + pre-mint provider → legitimate fresh mint.
describe('2. Nothing known + pre-mint provider → legitimate fresh mint', () => {
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: null,
    conversationId: null,
    supportsFreshPreMint: true
  })
  test('no resume target when nothing known', () => {
    expect(d.resolvedExistingId).toBe(null)
  })
  test('not resuming when nothing known', () => {
    expect(d.resuming).toBe(false)
  })
  test('fresh mint legitimate when nothing known + supported', () => {
    expect(d.shouldMintFresh).toBe(true)
  })
})

// 3. Nothing known + provider WITHOUT pre-mint (codex/cursor/opencode) → neither.
describe('3. Nothing known + provider WITHOUT pre-mint (codex/cursor/opencode) → neither', () => {
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: null,
    conversationId: null,
    supportsFreshPreMint: false
  })
  test('no slay-minted id for providers without {id}', () => {
    expect(d.shouldMintFresh).toBe(false)
  })
  test('not resuming', () => {
    expect(d.resuming).toBe(false)
  })
})

// 4. Renderer hint wins over ledger (precedence) + resumes.
describe('4. Renderer hint wins over ledger (precedence) + resumes', () => {
  const d = resolveSpawnConversation({
    existingConversationId: 'HINT',
    ledgerConversationId: 'LEDGER',
    conversationId: null,
    supportsFreshPreMint: true
  })
  test('renderer hint takes precedence over ledger', () => {
    expect(d.resolvedExistingId).toBe('HINT')
  })
  test('resume on hint, no mint', () => {
    expect(d.resuming).toBe(true && d.shouldMintFresh === false)
  })
})

// 5. Ledger null (e.g. strictly after a manual-reset cutoff) → fresh is correct,
//    not a clobber. A deliberate reset must still start fresh.
describe('5. Ledger null (e.g. strictly after a manual-reset cutoff) → fresh is correct,', () => {
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: null,
    conversationId: null,
    supportsFreshPreMint: true
  })
  test('reset cutoff (ledger null) → fresh is correct', () => {
    expect(d.shouldMintFresh).toBe(true)
  })
})

// 6. Explicit conversationId present (no resume target) → do NOT mint over it.
describe('6. Explicit conversationId present (no resume target) → do NOT mint over it', () => {
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: null,
    conversationId: 'EXPLICIT',
    supportsFreshPreMint: true
  })
  test('explicit conversationId suppresses fresh mint', () => {
    expect(d.shouldMintFresh).toBe(false)
  })
  test('explicit conversationId is not a resume target itself', () => {
    expect(d.resuming).toBe(false)
  })
})

// 7. Empty-string hint treated as absent → falls back to ledger.
describe('7. Empty-string hint treated as absent → falls back to ledger', () => {
  const d = resolveSpawnConversation({
    existingConversationId: '',
    ledgerConversationId: 'REAL',
    conversationId: null,
    supportsFreshPreMint: true
  })
  test('empty-string hint is treated as absent', () => {
    expect(d.resolvedExistingId).toBe('REAL')
  })
})
