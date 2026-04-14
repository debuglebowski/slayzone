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

export function resolveProjectByPath(db: SlayDb, dirPath: string): { id: string; name: string; path: string } {
  const normalized = dirPath.replace(/\/+$/, '')
  const projects = db.query<{ id: string; name: string; path: string }>(
    `SELECT id, name, path FROM projects WHERE path IS NOT NULL`
  )

  let best: { id: string; name: string; path: string } | null = null
  let bestLen = -1

  for (const p of projects) {
    const pPath = p.path.replace(/\/+$/, '')
    if (normalized === pPath || normalized.startsWith(pPath + '/')) {
      if (pPath.length > bestLen) {
        best = { id: p.id, name: p.name, path: p.path }
        bestLen = pPath.length
      }
    }
  }

  if (!best) {
    console.error(`No project found for directory: ${dirPath}`)
    console.error('Create a project with a path first, or use --project <name|id> to specify one.')
    process.exit(1)
  }
  return best
}

export function resolveProjectArg(opt?: string): string {
  const val = opt ?? process.env.SLAYZONE_PROJECT_ID
  if (!val) {
    console.error('No --project provided and $SLAYZONE_PROJECT_ID is not set.')
    process.exit(1)
  }
  return val
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
