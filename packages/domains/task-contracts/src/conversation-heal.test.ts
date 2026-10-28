import { expect, test } from 'vitest'
import {
  decideConversationHeal,
  type HealInput,
  type HealTranscriptMeta
} from './conversation-heal'
import { parseSqliteUtc } from './types'

// ---- parseSqliteUtc (timezone correctness) -------------------------------
test('SQLite space-form parsed as UTC', () => {
  expect(parseSqliteUtc('2026-06-04 06:57:50')).toBe(Date.parse('2026-06-04T06:57:50Z'))
})
test('ISO-Z preserved', () => {
  expect(parseSqliteUtc('2026-06-04T06:57:50.869Z')).toBe(Date.parse('2026-06-04T06:57:50.869Z'))
})
test('null → NaN', () => {
  expect(parseSqliteUtc(null)).toBeNaN()
})
test('empty → NaN', () => {
  expect(parseSqliteUtc('')).toBeNaN()
})

// ---- decideConversationHeal ---------------------------------------------
const T0 = Date.parse('2026-06-03T21:22:20Z') // task creation
const WINDOW = 5 * 60 * 1000
const NOW = T0 + 24 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

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
  storedFirstSeenAtMs: null,
  retentionMs: null,
  nowMs: NOW,
  ...o
})

const act = (i: HealInput): string => decideConversationHeal(i).action
const id = (i: HealInput): string | undefined => {
  const d = decideConversationHeal(i)
  return 'id' in d ? d.id : undefined
}

// keep: healthy pointers are never touched
test('stored transcript exists → keep', () => {
  expect(act(base({ storedExists: true }))).toBe('keep')
})
test('no stored id → keep (nothing to resume)', () => {
  expect(act(base({ storedId: null }))).toBe('keep')
})

// PROOF-OF-LIFE: transcript-on-disk is the ONLY evidence a stored id is
// resumable. `storedInHistory` alone is NOT proof — a zero-turn session (or one
// whose transcript was pruned) is in history but has no `.jsonl` to resume, so
// `claude --resume` fails forever. When history-membership is the only signal
// and the transcript is gone, heal must NOT keep the phantom.
test('in history AND transcript exists → keep', () => {
  expect(act(base({ storedInHistory: true, storedExists: true }))).toBe('keep')
})
test('in history but transcript MISSING → overlay (phantom, not resumable)', () => {
  expect(act(base({ storedInHistory: true, storedExists: false }))).toBe('overlay')
})
// …and if a surviving history entry exists, repoint to it rather than keep the
// phantom (the stored id itself must be skipped, per rule 2).
const phantomWithFallback = base({
  storedInHistory: true,
  storedExists: false,
  history: [
    { id: 'phantom', exists: false },
    { id: 'survivor', exists: true }
  ]
})
test('phantom-in-history with a surviving sibling → repoint to survivor', () => {
  expect(act(phantomWithFallback)).toBe('history')
  expect(id(phantomWithFallback)).toBe('survivor')
})
// even with a perfect orphan candidate, a healthy stored id wins
test('healthy stored id beats any candidate', () => {
  expect(act(base({ storedExists: true, candidates: [cand({})] }))).toBe('keep')
})

// history: exact fallback to a surviving recorded id
const hInput = base({
  history: [
    { id: 'old1', exists: false },
    { id: 'old2', exists: true }
  ]
})
test('falls back to surviving history entry', () => {
  expect(act(hInput)).toBe('history')
  expect(id(hInput)).toBe('old2')
})
// most-recent-first selection
const hInput2 = base({
  history: [
    { id: 'a', exists: true },
    { id: 'b', exists: true }
  ]
})
test('history picks most-recent surviving', () => {
  expect(id(hInput2)).toBe('b')
})
// history is preferred over orphan
const hInput3 = base({ history: [{ id: 'h', exists: true }], candidates: [cand({})] })
test('history preferred over orphan disk-guess', () => {
  expect(act(hInput3)).toBe('history')
})
// a history entry equal to the (broken) stored id is skipped
const hInput4 = base({ history: [{ id: 'phantom', exists: true }] })
test('history entry == stored phantom is ignored', () => {
  expect(act(hInput4)).toBe('overlay')
})

// orphan: the single near-certain case
test('sole in-window orphan → orphan', () => {
  expect(act(base({ candidates: [cand({})] }))).toBe('orphan')
})
test('orphan returns the matched id', () => {
  expect(id(base({ candidates: [cand({ id: 'real' })] }))).toBe('real')
})

// non-legacy tasks never disk-guess
test('non-legacy task never uses orphan path', () => {
  expect(
    act(
      base({
        task: { cwd: '/repo', gitBranch: 'main', createdAtMs: T0, isLegacy: false },
        candidates: [cand({})]
      })
    )
  ).toBe('overlay')
})

// MISATTRIBUTION GUARDS — every one must be overlay
test('wrong cwd → overlay', () => {
  expect(act(base({ candidates: [cand({ cwd: '/other' })] }))).toBe('overlay')
})
test('two candidates in dir+window → overlay', () => {
  expect(act(base({ candidates: [cand({ id: 'a' }), cand({ id: 'b' })] }))).toBe('overlay')
})
test('referenced orphan → overlay', () => {
  expect(act(base({ candidates: [cand({ referenced: true })] }))).toBe('overlay')
})
test('started before task creation → overlay', () => {
  expect(act(base({ candidates: [cand({ firstTsMs: T0 - 1 })] }))).toBe('overlay')
})
test('started after window → overlay', () => {
  expect(act(base({ candidates: [cand({ firstTsMs: T0 + WINDOW + 1 })] }))).toBe('overlay')
})
test('branch mismatch → overlay', () => {
  expect(act(base({ candidates: [cand({ gitBranch: 'feature' })] }))).toBe('overlay')
})
test('unknown task branch → overlay (never guess across branches)', () => {
  expect(
    act(
      base({
        task: { cwd: '/repo', gitBranch: null, createdAtMs: T0, isLegacy: true },
        candidates: [cand({ gitBranch: null })]
      })
    )
  ).toBe('overlay')
})
test('candidate branch unknown → overlay', () => {
  expect(act(base({ candidates: [cand({ gitBranch: null })] }))).toBe('overlay')
})
test('sidechain-only orphan → overlay', () => {
  expect(act(base({ candidates: [cand({ hasHumanTurn: false })] }))).toBe('overlay')
})
test('no timestamp → overlay', () => {
  expect(act(base({ candidates: [cand({ firstTsMs: null })] }))).toBe('overlay')
})

// a second referenced conversation in the same dir+window still blocks (ambiguous)
test('a referenced sibling in dir+window → ambiguous → overlay', () => {
  expect(
    act(base({ candidates: [cand({ id: 'mine' }), cand({ id: 'neighbor', referenced: true })] }))
  ).toBe('overlay')
})

// NEVER-WRITTEN: Claude writes `<id>.jsonl` at the first prompt, and prunes it
// only once its mtime is older than `cleanupPeriodDays`. So a missing transcript
// for an id slay first saw less than one retention period ago cannot have been
// pruned — nothing was ever written, nothing is lost, and the honest answer is a
// fresh start under the same id, not "session expired" (task fa117add: agent
// spawned, never prompted, every reopen showed the overlay).
const young = { storedFirstSeenAtMs: NOW - 60 * 60 * 1000, retentionMs: 90 * DAY }
const nonLegacy = { cwd: '/repo', gitBranch: 'main', createdAtMs: T0, isLegacy: false }
test('young id, no transcript, nothing on disk → fresh', () => {
  expect(act(base(young))).toBe('fresh')
})
test('non-legacy task: young never-written id → fresh', () => {
  expect(act(base({ ...young, task: nonLegacy }))).toBe('fresh')
})
test('older than retention → may have been pruned → overlay', () => {
  expect(act(base({ ...young, storedFirstSeenAtMs: NOW - 91 * DAY }))).toBe('overlay')
})
test('exactly one retention period old → overlay (boundary is conservative)', () => {
  expect(act(base({ ...young, storedFirstSeenAtMs: NOW - 90 * DAY }))).toBe('overlay')
})
test('first-seen unknown → overlay', () => {
  expect(act(base({ ...young, storedFirstSeenAtMs: null }))).toBe('overlay')
})
test('retention unknown → overlay', () => {
  expect(act(base({ ...young, retentionMs: null }))).toBe('overlay')
})
test('retention 0 → overlay', () => {
  expect(act(base({ ...young, retentionMs: 0 }))).toBe('overlay')
})
test('young AND on disk → keep', () => {
  expect(act(base({ ...young, storedExists: true }))).toBe('keep')
})
test('a surviving sibling beats fresh', () => {
  expect(act(base({ ...young, history: [{ id: 'survivor', exists: true }] }))).toBe('history')
})
test('a legacy orphan beats fresh', () => {
  expect(act(base({ ...young, candidates: [cand({})] }))).toBe('orphan')
})
test('ambiguous orphans are never attached; young id still → fresh', () => {
  expect(act(base({ ...young, candidates: [cand({ id: 'a' }), cand({ id: 'b' })] }))).toBe('fresh')
})
