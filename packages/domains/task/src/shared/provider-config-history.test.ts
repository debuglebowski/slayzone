import { appendProviderConversationId, CONVERSATION_HISTORY_CAP, type ProviderConfig } from './types'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const M = 'claude-code'
const hist = (cfg: ProviderConfig): string[] => cfg[M]?.conversationHistory ?? []

// Append to empty.
assert(
  JSON.stringify(hist(appendProviderConversationId(null, M, 'a'))) === JSON.stringify(['a']),
  'append to null cfg seeds history'
)

// Most-recent-last ordering.
let cfg: ProviderConfig = {}
cfg = appendProviderConversationId(cfg, M, 'a')
cfg = appendProviderConversationId(cfg, M, 'b')
cfg = appendProviderConversationId(cfg, M, 'c')
assert(JSON.stringify(hist(cfg)) === JSON.stringify(['a', 'b', 'c']), 'appends most-recent-last')

// Dedup: re-appending an existing id moves it to the end (no duplicate).
cfg = appendProviderConversationId(cfg, M, 'a')
assert(JSON.stringify(hist(cfg)) === JSON.stringify(['b', 'c', 'a']), 're-append moves id to end, deduped')

// Idempotent re-append of the current most-recent.
cfg = appendProviderConversationId(cfg, M, 'a')
assert(JSON.stringify(hist(cfg)) === JSON.stringify(['b', 'c', 'a']), 're-append of last is a no-op')

// Cap: never exceeds CONVERSATION_HISTORY_CAP, keeps the most recent.
let capped: ProviderConfig = {}
for (let i = 0; i < CONVERSATION_HISTORY_CAP + 5; i++) {
  capped = appendProviderConversationId(capped, M, `id-${i}`)
}
const cappedHist = hist(capped)
assert(cappedHist.length === CONVERSATION_HISTORY_CAP, 'history capped at CONVERSATION_HISTORY_CAP')
assert(cappedHist[cappedHist.length - 1] === `id-${CONVERSATION_HISTORY_CAP + 4}`, 'cap keeps newest')
assert(cappedHist[0] === `id-5`, 'cap drops oldest')

// Preserves other fields of the mode entry.
const withFlags: ProviderConfig = { [M]: { flags: '--x', conversationId: 'live' } }
const after = appendProviderConversationId(withFlags, M, 'h1')
assert(after[M]?.flags === '--x', 'append preserves flags')
assert(after[M]?.conversationId === 'live', 'append preserves conversationId')

// Does not disturb other modes.
const multi: ProviderConfig = { codex: { conversationId: 'cx' } }
const after2 = appendProviderConversationId(multi, M, 'h1')
assert(after2.codex?.conversationId === 'cx', 'append leaves other modes untouched')

console.log('provider-config-history: all passed')
