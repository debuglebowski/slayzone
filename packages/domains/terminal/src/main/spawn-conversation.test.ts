/**
 * Unit tests for resolveSpawnConversation — the fresh-vs-resume invariant that
 * guards the restart-clobber regression: a known conversation (renderer hint OR
 * ledger-resolved by main) must RESUME, never fresh-mint over it.
 * Run with: npx tsx <file>
 */
import { resolveSpawnConversation } from './spawn-conversation'

let pass = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  pass++
}

// 1. THE regression guard: ledger id present, renderer hint absent → RESUME, no mint.
//    This is exactly the restart-clobber: boot board store hadn't hydrated the
//    hint, but main resolves the real id from the ledger.
{
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: 'REAL',
    conversationId: null,
    supportsFreshPreMint: true
  })
  assert(d.resolvedExistingId === 'REAL', 'ledger id resolves when hint absent')
  assert(d.resuming === true, 'resuming when ledger id present')
  assert(d.shouldMintFresh === false, 'must NOT mint fresh over a known ledger conversation')
}

// 2. Nothing known + pre-mint provider → legitimate fresh mint.
{
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: null,
    conversationId: null,
    supportsFreshPreMint: true
  })
  assert(d.resolvedExistingId === null, 'no resume target when nothing known')
  assert(d.resuming === false, 'not resuming when nothing known')
  assert(d.shouldMintFresh === true, 'fresh mint legitimate when nothing known + supported')
}

// 3. Nothing known + provider WITHOUT pre-mint (codex/cursor/opencode) → neither.
{
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: null,
    conversationId: null,
    supportsFreshPreMint: false
  })
  assert(d.shouldMintFresh === false, 'no slay-minted id for providers without {id}')
  assert(d.resuming === false, 'not resuming')
}

// 4. Renderer hint wins over ledger (precedence) + resumes.
{
  const d = resolveSpawnConversation({
    existingConversationId: 'HINT',
    ledgerConversationId: 'LEDGER',
    conversationId: null,
    supportsFreshPreMint: true
  })
  assert(d.resolvedExistingId === 'HINT', 'renderer hint takes precedence over ledger')
  assert(d.resuming === true && d.shouldMintFresh === false, 'resume on hint, no mint')
}

// 5. Ledger null (e.g. strictly after a manual-reset cutoff) → fresh is correct,
//    not a clobber. A deliberate reset must still start fresh.
{
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: null,
    conversationId: null,
    supportsFreshPreMint: true
  })
  assert(d.shouldMintFresh === true, 'reset cutoff (ledger null) → fresh is correct')
}

// 6. Explicit conversationId present (no resume target) → do NOT mint over it.
{
  const d = resolveSpawnConversation({
    existingConversationId: null,
    ledgerConversationId: null,
    conversationId: 'EXPLICIT',
    supportsFreshPreMint: true
  })
  assert(d.shouldMintFresh === false, 'explicit conversationId suppresses fresh mint')
  assert(d.resuming === false, 'explicit conversationId is not a resume target itself')
}

// 7. Empty-string hint treated as absent → falls back to ledger.
{
  const d = resolveSpawnConversation({
    existingConversationId: '',
    ledgerConversationId: 'REAL',
    conversationId: null,
    supportsFreshPreMint: true
  })
  assert(d.resolvedExistingId === 'REAL', 'empty-string hint is treated as absent')
}

console.log(`OK — resolveSpawnConversation ${pass} checks passed`)
