import type { SlayzoneDb } from '@slayzone/platform'

export type UsageMap = Record<string, Record<string, number>>

export async function bumpAutocompleteUsage(
  db: SlayzoneDb,
  source: string,
  name: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO autocomplete_usage (source, name, count) VALUES (?, ?, 1)
     ON CONFLICT(source, name) DO UPDATE SET count = count + 1`
    )
    .run(source, name)
}

export async function getAutocompleteUsage(db: SlayzoneDb): Promise<UsageMap> {
  const rows = (await db.prepare('SELECT source, name, count FROM autocomplete_usage').all()) as {
    source: string
    name: string
    count: number
  }[]
  const map: UsageMap = {}
  for (const r of rows) {
    if (!map[r.source]) map[r.source] = {}
    map[r.source][r.name] = r.count
  }
  return map
}
