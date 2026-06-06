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
  | 'cas-repoint-heal'
  | 'legacy-migration'
  | 'foreign-observed'
  | 'manual-reset'
  | 'pending-spawn'

/**
 * Origins whose rows can become the "current" conversation on read.
 * Foreign / pending / manual-reset rows are recorded but never resumed.
 */
export const HONORED_ORIGINS: ReadonlySet<ConversationOrigin> = new Set([
  'slay-spawned-fresh',
  'slay-spawned-resume',
  'cas-repoint-heal',
  'legacy-migration'
])

/** Every value of `ConversationOrigin`, for tests + CHECK-constraint sync. */
export const ALL_ORIGINS: readonly ConversationOrigin[] = [
  'slay-spawned-fresh',
  'slay-spawned-resume',
  'cas-repoint-heal',
  'legacy-migration',
  'foreign-observed',
  'manual-reset',
  'pending-spawn'
]
