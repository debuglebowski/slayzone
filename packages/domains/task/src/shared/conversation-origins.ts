/**
 * Provenance tag for each row in `task_conversations`. Decides whether the
 * row is honored by `getCurrentConversationId` on read.
 *
 * If you add a value here, also add it to the CHECK constraint in migration
 * v145 — the enum/CHECK sync test (`task-conversations.test.ts`) catches drift
 * by asserting every value in this union INSERTs cleanly.
 */
export type ConversationOrigin =
  | 'slay-spawned-fresh'
  | 'slay-spawned-resume'
  | 'in-band-clear'
  | 'cas-repoint-heal'
  | 'legacy-migration'
  | 'foreign-observed'
  | 'manual-reset'
  | 'pending-spawn'

/**
 * Origins whose rows can become the "current" conversation on read.
 * Foreign / pending / manual-reset rows are recorded but never resumed.
 *
 * `in-band-clear` is honored: the agent rotated its own session id in place
 * (`/clear`) inside a process slay provably spawned for this (task, mode), so
 * the new id is as legitimate as a fresh spawn's. It stays a DISTINCT value
 * rather than folding into `slay-spawned-fresh` so the audit trail can still
 * answer "did the user clear, or did slay spawn this?".
 */
export const HONORED_ORIGINS: ReadonlySet<ConversationOrigin> = new Set([
  'slay-spawned-fresh',
  'slay-spawned-resume',
  'in-band-clear',
  'cas-repoint-heal',
  'legacy-migration'
])

/** Every value of `ConversationOrigin`, for tests + CHECK-constraint sync. */
export const ALL_ORIGINS: readonly ConversationOrigin[] = [
  'slay-spawned-fresh',
  'slay-spawned-resume',
  'in-band-clear',
  'cas-repoint-heal',
  'legacy-migration',
  'foreign-observed',
  'manual-reset',
  'pending-spawn'
]

/**
 * The honored set as a SQL literal list — `'a','b',…` — for embedding in an
 * `origin IN (…)` clause. Single source of truth: every reader that gates on
 * provenance interpolates THIS instead of repeating the literals, so adding an
 * origin to `HONORED_ORIGINS` can never leave a reader behind (the bug that let
 * a new honored origin be invisible to `listTaskSessions` while
 * `getCurrentConversationId` honored it).
 *
 * Safe to interpolate: the values are compile-time constants from the union
 * above, never user input.
 */
export const HONORED_ORIGINS_SQL: string = [...HONORED_ORIGINS]
  .map((o) => `'${o}'`)
  .join(',')
