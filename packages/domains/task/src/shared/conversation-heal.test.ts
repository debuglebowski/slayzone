import { decideConversationHeal, type HealInput, type HealTranscriptMeta } from './conversation-heal'
import { parseSqliteUtc } from './types'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// ---- parseSqliteUtc (timezone correctness) -------------------------------
assert(
  parseSqliteUtc('2026-06-04 06:57:50') === Date.parse('2026-06-04T06:57:50Z'),
  'SQLite space-form parsed as UTC'
)
assert(
  parseSqliteUtc('2026-06-04T06:57:50.869Z') === Date.parse('2026-06-04T06:57:50.869Z'),
  'ISO-Z preserved'
)
assert(Number.isNaN(parseSqliteUtc(null)), 'null → NaN')
assert(Number.isNaN(parseSqliteUtc('')), 'empty → NaN')

// ---- decideConversationHeal ---------------------------------------------
const T0 = Date.parse('2026-06-03T21:22:20Z') // task creation
const WINDOW = 5 * 60 * 1000

const cand = (o: Partial<HealTranscriptMeta>): HealTranscriptMeta => ({
  id: 'orphan',
  cwd: '/repo',
  firstTsMs: T0 + 60_000, // 60s after creation — inside window
  gitBranch: 'main',
  hasHumanTurn: true,
  referenced: false,
  ...o
})

const base = (o: Partial<HealInput>): HealInput => ({
  storedId: 'phantom',
  storedExists: false,
  storedInHistory: false,
  history: [],
  task: { cwd: '/repo', gitBranch: 'main', createdAtMs: T0, isLegacy: true },
  candidates: [],
  windowMs: WINDOW,
  ...o
})

const act = (i: HealInput): string => decideConversationHeal(i).action
const id = (i: HealInput): string | undefined => {
  const d = decideConversationHeal(i)
  return 'id' in d ? d.id : undefined
}

// keep: healthy pointers are never touched
assert(act(base({ storedExists: true })) === 'keep', 'stored transcript exists → keep')
assert(act(base({ storedId: null })) === 'keep', 'no stored id → keep (nothing to resume)')

// PROOF-OF-LIFE: transcript-on-disk is the ONLY evidence a stored id is
// resumable. `storedInHistory` alone is NOT proof — a zero-turn session (or one
// whose transcript was pruned) is in history but has no `.jsonl` to resume, so
// `claude --resume` fails forever. When history-membership is the only signal
// and the transcript is gone, heal must NOT keep the phantom.
assert(
  act(base({ storedInHistory: true, storedExists: true })) === 'keep',
  'in history AND transcript exists → keep'
)
assert(
  act(base({ storedInHistory: true, storedExists: false })) === 'overlay',
  'in history but transcript MISSING → overlay (phantom, not resumable)'
)
// …and if a surviving history entry exists, repoint to it rather than keep the
// phantom (the stored id itself must be skipped, per rule 2).
const phantomWithFallback = base({
  storedInHistory: true,
  storedExists: false,
  history: [{ id: 'phantom', exists: false }, { id: 'survivor', exists: true }]
})
assert(
  act(phantomWithFallback) === 'history' && id(phantomWithFallback) === 'survivor',
  'phantom-in-history with a surviving sibling → repoint to survivor'
)
// even with a perfect orphan candidate, a healthy stored id wins
assert(
  act(base({ storedExists: true, candidates: [cand({})] })) === 'keep',
  'healthy stored id beats any candidate'
)

// history: exact fallback to a surviving recorded id
const hInput = base({ history: [{ id: 'old1', exists: false }, { id: 'old2', exists: true }] })
assert(act(hInput) === 'history' && id(hInput) === 'old2', 'falls back to surviving history entry')
// most-recent-first selection
const hInput2 = base({ history: [{ id: 'a', exists: true }, { id: 'b', exists: true }] })
assert(id(hInput2) === 'b', 'history picks most-recent surviving')
// history is preferred over orphan
const hInput3 = base({ history: [{ id: 'h', exists: true }], candidates: [cand({})] })
assert(act(hInput3) === 'history', 'history preferred over orphan disk-guess')
// a history entry equal to the (broken) stored id is skipped
const hInput4 = base({ history: [{ id: 'phantom', exists: true }] })
assert(act(hInput4) === 'overlay', 'history entry == stored phantom is ignored')

// orphan: the single near-certain case
assert(act(base({ candidates: [cand({})] })) === 'orphan', 'sole in-window orphan → orphan')
assert(id(base({ candidates: [cand({ id: 'real' })] })) === 'real', 'orphan returns the matched id')

// non-legacy tasks never disk-guess
assert(
  act(base({ task: { cwd: '/repo', gitBranch: 'main', createdAtMs: T0, isLegacy: false }, candidates: [cand({})] })) ===
    'overlay',
  'non-legacy task never uses orphan path'
)

// MISATTRIBUTION GUARDS — every one must be overlay
assert(act(base({ candidates: [cand({ cwd: '/other' })] })) === 'overlay', 'wrong cwd → overlay')
assert(
  act(base({ candidates: [cand({ id: 'a' }), cand({ id: 'b' })] })) === 'overlay',
  'two candidates in dir+window → overlay'
)
assert(act(base({ candidates: [cand({ referenced: true })] })) === 'overlay', 'referenced orphan → overlay')
assert(
  act(base({ candidates: [cand({ firstTsMs: T0 - 1 })] })) === 'overlay',
  'started before task creation → overlay'
)
assert(
  act(base({ candidates: [cand({ firstTsMs: T0 + WINDOW + 1 })] })) === 'overlay',
  'started after window → overlay'
)
assert(act(base({ candidates: [cand({ gitBranch: 'feature' })] })) === 'overlay', 'branch mismatch → overlay')
assert(
  act(base({ task: { cwd: '/repo', gitBranch: null, createdAtMs: T0, isLegacy: true }, candidates: [cand({ gitBranch: null })] })) ===
    'overlay',
  'unknown task branch → overlay (never guess across branches)'
)
assert(act(base({ candidates: [cand({ gitBranch: null })] })) === 'overlay', 'candidate branch unknown → overlay')
assert(act(base({ candidates: [cand({ hasHumanTurn: false })] })) === 'overlay', 'sidechain-only orphan → overlay')
assert(act(base({ candidates: [cand({ firstTsMs: null })] })) === 'overlay', 'no timestamp → overlay')

// a second referenced conversation in the same dir+window still blocks (ambiguous)
assert(
  act(base({ candidates: [cand({ id: 'mine' }), cand({ id: 'neighbor', referenced: true })] })) === 'overlay',
  'a referenced sibling in dir+window → ambiguous → overlay'
)

console.log('conversation-heal: all passed')
