/**
 * Pure helpers with no external dependencies — safe to import from ESM test files.
 * db.ts re-exports these for backwards compatibility.
 */

type SqlParams = Record<string, string | number | bigint | null | Uint8Array>

export interface SlayDb {
  query<T extends object>(sql: string, params?: SqlParams): T[]
  run(sql: string, params?: SqlParams): void
  close(): void
}

export function resolveProject(db: SlayDb, proj: string): { id: string; name: string } {
  const projects = db.query<{ id: string; name: string }>(
    `SELECT id, name FROM projects WHERE id = :proj OR LOWER(name) LIKE :projLike LIMIT 10`,
    { ':proj': proj, ':projLike': `%${proj.toLowerCase()}%` }
  )

  if (projects.length === 0) {
    const all = db.query<{ name: string }>('SELECT name FROM projects ORDER BY name')
    console.error(`No project matching "${proj}".`)
    console.error(`Available: ${all.map((p) => p.name).join(', ')}`)
    process.exit(1)
  }
  if (projects.length > 1) {
    console.error(`Ambiguous project "${proj}". Matches: ${projects.map((p) => p.name).join(', ')}`)
    process.exit(1)
  }
  return projects[0]
}
