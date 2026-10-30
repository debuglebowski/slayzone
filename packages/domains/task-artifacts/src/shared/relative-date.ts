/**
 * How long ago a timestamp was, as the artifacts panel says it: `just now`, `45m ago`,
 * `5h ago`, `3d ago`, else the day (`Oct 1`). DOM-free: desktop and the phone share it.
 */
export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/

/**
 * An artifact row's `created_at` / `updated_at` as ISO 8601 with its zone. Rows carry two
 * forms: SQLite's `datetime('now')` (`2026-10-30 10:00:00`, UTC but without a zone, which
 * `new Date()` reads as local time — or not at all, on Hermes) and `toISOString()`. The
 * first becomes `2026-10-30T10:00:00Z`; anything else is returned as it is.
 */
export function dbTimestampToIso(value: string): string {
  const m = SQLITE_UTC.exec(value)
  return m ? `${m[1]}T${m[2]}Z` : value
}
