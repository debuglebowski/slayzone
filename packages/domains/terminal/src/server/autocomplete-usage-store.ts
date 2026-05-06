import type { Database } from 'better-sqlite3'

export type UsageMap = Record<string, Record<string, number>>

export function bumpAutocompleteUsage(
  db: Database,
  source: string,
  name: string
): void {
  db.prepare(
    `INSERT INTO autocomplete_usage (source, name, count) VALUES (?, ?, 1)
     ON CONFLICT(source, name) DO UPDATE SET count = count + 1`
  ).run(source, name)
}

export function getAutocompleteUsage(db: Database): UsageMap {
  const rows = db
    .prepare('SELECT source, name, count FROM autocomplete_usage')
    .all() as { source: string; name: string; count: number }[]
  const map: UsageMap = {}
  for (const r of rows) {
    if (!map[r.source]) map[r.source] = {}
    map[r.source][r.name] = r.count
  }
  return map
}
