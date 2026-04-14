/** SQLite PRAGMAs required for all connections to the SlayZone database. */
export const DB_PRAGMAS = [
  'journal_mode = WAL',
  'foreign_keys = ON',
  'synchronous = NORMAL',
  'cache_size = -8000',
  'busy_timeout = 5000',
] as const
