/**
 * The hub's legacy (hub-era) chat tables — robustness plan §9, Phase 8.
 *
 * Chat history moved to the computers; the hub kept these tables only as the
 * migration SOURCE for chats it still held. Once an install has nothing left to
 * migrate, the hub's boot step drops them (`settleLegacyChatTables`,
 * `@slayzone/chat-runtime/hub`), so code that still names them must check first.
 *
 * Presence only changes at hub BOOT, before any service runs (the drop step, or a
 * restored backup — a restore relaunches the hub), so it is memoized per database
 * handle. The boot step resets the memo for its handle.
 *
 * @module platform/legacy-chat-tables
 */

/** Legacy chat CONTENT: the drop waits until every one is empty. Child tables first. */
export const LEGACY_CHAT_CONTENT_TABLES = [
  'chat_workspace_diffs',
  'chat_workspace_changes',
  'chat_events',
  'chat_queue',
  'chat_tab_state',
  'chat_timeline_pages',
  'chat_timeline_checkpoints',
  'chat_attachment_messages'
] as const

/** Migration bookkeeping that only means something while legacy content exists. */
export const LEGACY_CHAT_BOOKKEEPING_TABLES = [
  'chat_legacy_session_authority',
  'chat_legacy_tab_computers'
] as const

/** Everything the drop removes, in drop order. */
export const LEGACY_CHAT_TABLES = [
  ...LEGACY_CHAT_CONTENT_TABLES,
  ...LEGACY_CHAT_BOOKKEEPING_TABLES
] as const
export type LegacyChatTable = (typeof LEGACY_CHAT_TABLES)[number]

/** `settings` key holding when this install's legacy chat tables were dropped (Unix ms). */
export const LEGACY_CHAT_TABLES_DROPPED_SETTING = 'chat.legacy_tables_dropped_at'

/** SQL listing which of the legacy chat tables exist. */
export const LEGACY_CHAT_TABLES_PRESENT_SQL = `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${LEGACY_CHAT_TABLES.map(
  (t) => `'${t}'`
).join(',')})`

/** Any async handle (`SlayzoneDb`, or a test double that only prepares statements). */
interface AsyncPrepare {
  prepare(sql: string): { all(...params: unknown[]): Promise<unknown[]> }
}

const memo = new WeakMap<object, Promise<boolean>>()

/**
 * Whether this database still has the legacy chat tables (all of them, or — after
 * an interrupted manual edit — some: then still true, and the boot step drops the
 * rest). A failed lookup is not memoized.
 */
export function legacyChatTables(db: AsyncPrepare): Promise<boolean> {
  const known = memo.get(db)
  if (known) return known
  const lookup = db
    .prepare(LEGACY_CHAT_TABLES_PRESENT_SQL)
    .all()
    .then((rows) => rows.length > 0)
  memo.set(db, lookup)
  lookup.catch(() => {
    if (memo.get(db) === lookup) memo.delete(db)
  })
  return lookup
}

/** The boot step's verdict for `db` (or `undefined`: look it up again). */
export function setLegacyChatTables(db: object, present: boolean | undefined): void {
  if (present === undefined) memo.delete(db)
  else memo.set(db, Promise.resolve(present))
}

/** Synchronous lookup for a raw better-sqlite3 handle (never memoized). */
export function legacyChatTablesSync(db: {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}): Set<LegacyChatTable> {
  return new Set(
    (db.prepare(LEGACY_CHAT_TABLES_PRESENT_SQL).all() as Array<{ name: LegacyChatTable }>).map(
      (r) => r.name
    )
  )
}

/** A write that would need a legacy chat table this install no longer has. */
export class LegacyChatStorageRetiredError extends Error {
  constructor(what: string) {
    super(
      `Legacy hub chat storage was retired on this install (chat history lives on its computer): ${what}`
    )
    this.name = 'LegacyChatStorageRetiredError'
  }
}
