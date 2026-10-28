/**
 * Provenance tag for each row in `task_conversations`. Decides whether the
 * row is honored by `getCurrentConversationId` on read.
 *
 * Owned here (not by the task package) because the terminal runtime produces
 * these tags (chat transport session-id classification) and terminal must not
 * import task. Task's shared barrel re-exports it alongside
 * `HONORED_ORIGINS` / `ALL_ORIGINS`.
 *
 * If you add a value here, also add it to the CHECK constraint in migration
 * v145 — the enum/CHECK sync test (`task-conversations.test.ts`) catches drift
 * by asserting every value in this union INSERTs cleanly.
 */
export type ConversationOrigin =
  | 'slay-spawned-fresh'
  | 'slay-spawned-resume'
  | 'in-band-clear'
  | 'user-selected'
  | 'cas-repoint-heal'
  | 'legacy-migration'
  | 'foreign-observed'
  | 'manual-reset'
  | 'pending-spawn'
