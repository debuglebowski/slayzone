import type Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const SIZE_THRESHOLD_BYTES = 500 * 1024 * 1024
const SALVAGE_ROW_LIMIT = 100_000
const SALVAGE_STALE_MS = 24 * 60 * 60 * 1000
const MERGE_DELAY_MS = 5_000
const DB_SUFFIXES = ['', '-wal', '-shm'] as const

export interface SelfHealResult {
  rotated: boolean
  reason?: string
  salvagePath?: string
  originalSizeBytes?: number
}

export function selfHealDiagnosticsDb(dbPath: string): SelfHealResult {
  let stat: fs.Stats
  try {
    stat = fs.statSync(dbPath)
  } catch {
    return { rotated: false }
  }

  if (stat.size <= SIZE_THRESHOLD_BYTES) return { rotated: false }

  const salvagePath = `${dbPath}.salvage.${Date.now()}.sqlite`
  fs.renameSync(dbPath, salvagePath)
  for (const suffix of DB_SUFFIXES) {
    if (suffix === '') continue
    const src = `${dbPath}${suffix}`
    if (!fs.existsSync(src)) continue
    try {
      fs.renameSync(src, `${salvagePath}${suffix}`)
    } catch {
      try {
        fs.unlinkSync(src)
      } catch {
        /* ignore */
      }
    }
  }

  console.warn(
    `[diagnostics] DB ${formatBytes(stat.size)} exceeded ${formatBytes(SIZE_THRESHOLD_BYTES)} cap. ` +
      `Rotated to ${path.basename(salvagePath)}. Newest ${SALVAGE_ROW_LIMIT} rows will salvage in background.`
  )

  return {
    rotated: true,
    reason: 'size_cap_exceeded',
    salvagePath,
    originalSizeBytes: stat.size
  }
}

export function scheduleSalvageMergeForAll(
  getDb: () => Database.Database | null,
  dbPath: string
): void {
  const salvageFiles = findSalvageFiles(dbPath)
  if (salvageFiles.length === 0) return

  setTimeout(() => {
    for (const salvagePath of salvageFiles) {
      try {
        const stat = fs.statSync(salvagePath)
        if (Date.now() - stat.mtimeMs > SALVAGE_STALE_MS) {
          deleteSalvage(salvagePath)
          continue
        }
        const db = getDb()
        if (!db) return
        mergeSalvage(db, salvagePath)
        deleteSalvage(salvagePath)
      } catch (err) {
        console.error(`[diagnostics] salvage merge failed for ${path.basename(salvagePath)}:`, err)
      }
    }
  }, MERGE_DELAY_MS)
}

export function mergeSalvage(db: Database.Database, salvagePath: string): { inserted: number } {
  if (!fs.existsSync(salvagePath)) return { inserted: 0 }

  const escaped = salvagePath.replace(/'/g, "''")
  db.exec(`ATTACH '${escaped}' AS salvage`)
  try {
    const res = db
      .prepare(`
        INSERT OR IGNORE INTO diagnostics_events
        SELECT * FROM salvage.diagnostics_events
        ORDER BY ts_ms DESC LIMIT ?
      `)
      .run(SALVAGE_ROW_LIMIT)
    return { inserted: Number(res.changes) }
  } finally {
    db.exec('DETACH salvage')
  }
}

function findSalvageFiles(dbPath: string): string[] {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  const prefix = `${base}.salvage.`
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((e) => e.startsWith(prefix) && e.endsWith('.sqlite'))
    .map((e) => path.join(dir, e))
}

function deleteSalvage(salvagePath: string): void {
  for (const suffix of DB_SUFFIXES) {
    try {
      fs.unlinkSync(`${salvagePath}${suffix}`)
    } catch {
      /* ignore */
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
