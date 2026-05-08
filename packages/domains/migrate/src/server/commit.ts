import {
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { isEmptyServer } from './health'
import { PRUNE_SETTINGS_KEYS, SKIP_TABLES, type Manifest, type MigrateReceipt, type TableCheck } from '../shared'

interface CommitOptions {
  db: Database
  /** Absolute path to dataRoot for the destination server. */
  dataRoot: string
  /** Absolute path to the unpacked archive root (contains db.sqlite, artifacts/, etc.). */
  unpackedDir: string
  manifest: Manifest
  /** When true, do everything except mutating destination state. */
  dryRun: boolean
}

export interface CommitResult extends MigrateReceipt {
  /** Internal: whether the SQL transaction was committed (false for dry-run + on rollback). */
  committed: boolean
}

const PRUNE_TABLES_FROM_SQL = (name: string): boolean => {
  if (name.startsWith('sqlite_')) return false
  if (SKIP_TABLES.has(name)) return false
  // Skip ephemeral migration leftovers if any survived (older repos had `_new` interim tables).
  if (name.endsWith('_new')) return false
  return true
}

function listUserTables(db: Database, dbName: string = 'main'): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM ${dbName}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name).filter(PRUNE_TABLES_FROM_SQL)
}

function getColumns(db: Database, dbName: string, table: string): string[] {
  const rows = db.prepare(`PRAGMA ${dbName}.table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export function commitMigration(opts: CommitOptions): CommitResult {
  const startedAt = Date.now()
  const errors: string[] = []
  const tables: Record<string, TableCheck> = {}
  let worktreeRowsRewritten = 0

  const srcDbPath = join(opts.unpackedDir, 'db.sqlite')
  if (!existsSync(srcDbPath)) {
    throw new Error('Archive missing db.sqlite')
  }

  // Sanity (race-safe re-check): destination must still be empty.
  if (!isEmptyServer(opts.db)) {
    throw new Error('Destination server is no longer empty (race condition); aborting')
  }

  const srcUserVersion = readPragmaFromAttached(opts.db, srcDbPath, 'user_version')
  const dstUserVersion = opts.db.pragma('user_version', { simple: true }) as number
  if (srcUserVersion !== dstUserVersion) {
    throw new Error(
      `Schema version mismatch: source user_version=${srcUserVersion}, destination user_version=${dstUserVersion}`,
    )
  }

  // Attach source DB. We always detach in `finally`.
  opts.db.exec(`ATTACH DATABASE '${srcDbPath.replaceAll("'", "''")}' AS src`)

  let committed = false
  try {
    if (opts.dryRun) {
      // Dry-run: enumerate counts that would import; no writes.
      const srcTables = listUserTables(opts.db, 'src')
      for (const table of srcTables) {
        const expected = (opts.db.prepare(`SELECT COUNT(*) AS n FROM src.${quoteIdent(table)}`).get() as { n: number }).n
        tables[table] = { expected, actual: 0 }
      }
      // Count expected worktree rewrites.
      const wtCount = (opts.db.prepare(`SELECT COUNT(*) AS n FROM src.tasks WHERE worktree_path IS NOT NULL`).get() as { n: number } | undefined)?.n ?? 0
      worktreeRowsRewritten = wtCount

      const fileCheck = filesInManifest(opts)
      return {
        ok: true,
        dryRun: true,
        files: fileCheck,
        tables,
        worktreeRowsRewritten,
        durationMs: Date.now() - startedAt,
        errors,
        committed: false,
      }
    }

    const tx = opts.db.transaction(() => {
      const srcTables = listUserTables(opts.db, 'src')
      const dstTables = new Set(listUserTables(opts.db, 'main'))

      for (const table of srcTables) {
        if (!dstTables.has(table)) {
          // Source table that doesn't exist in destination — skip with warning.
          errors.push(`Skipped table missing in destination: ${table}`)
          continue
        }
        const srcCols = getColumns(opts.db, 'src', table)
        const dstCols = new Set(getColumns(opts.db, 'main', table))
        const sharedCols = srcCols.filter((c) => dstCols.has(c))
        if (sharedCols.length === 0) {
          errors.push(`No shared columns for table ${table}; skipping`)
          continue
        }
        const colList = sharedCols.map(quoteIdent).join(', ')
        const expected = (opts.db.prepare(`SELECT COUNT(*) AS n FROM src.${quoteIdent(table)}`).get() as { n: number }).n
        opts.db
          .prepare(
            `INSERT INTO main.${quoteIdent(table)} (${colList}) SELECT ${colList} FROM src.${quoteIdent(table)}`,
          )
          .run()
        const actual = (opts.db.prepare(`SELECT COUNT(*) AS n FROM main.${quoteIdent(table)}`).get() as { n: number }).n
        tables[table] = { expected, actual }
        if (expected !== actual) {
          throw new Error(
            `Row count mismatch for table ${table}: expected ${expected}, got ${actual}`,
          )
        }
      }

      // Rewrite worktree paths.
      if (dstTables.has('tasks')) {
        const updRes = opts.db
          .prepare(`UPDATE main.tasks SET worktree_path = NULL WHERE worktree_path IS NOT NULL`)
          .run()
        worktreeRowsRewritten = updRes.changes
      }

      // Prune server-process-local settings keys.
      if (dstTables.has('settings')) {
        for (const key of PRUNE_SETTINGS_KEYS) {
          opts.db.prepare(`DELETE FROM main.settings WHERE key = ?`).run(key)
        }
      }

      // Sync user_version (already equal per pre-check, but explicit for cross-version safety).
      opts.db.pragma(`user_version = ${srcUserVersion}`)
    })

    tx()
    committed = true

    // Move filesystem assets (artifacts/, project-icons/, .secret) into dataRoot.
    moveDataDirIfPresent(opts.unpackedDir, opts.dataRoot, 'artifacts')
    moveDataDirIfPresent(opts.unpackedDir, opts.dataRoot, 'project-icons')
    moveSecretIfPresent(opts.unpackedDir, opts.dataRoot)

    return {
      ok: true,
      dryRun: false,
      files: filesInManifest(opts),
      tables,
      worktreeRowsRewritten,
      durationMs: Date.now() - startedAt,
      errors,
      committed: true,
    }
  } catch (err) {
    return {
      ok: false,
      dryRun: opts.dryRun,
      files: { expected: opts.manifest.files.length, present: 0, mismatched: [] },
      tables,
      worktreeRowsRewritten,
      durationMs: Date.now() - startedAt,
      errors: [...errors, err instanceof Error ? err.message : String(err)],
      committed,
    }
  } finally {
    try {
      opts.db.exec('DETACH DATABASE src')
    } catch {
      /* already detached */
    }
  }
}

function readPragmaFromAttached(db: Database, srcDbPath: string, pragma: string): number {
  // Open temporarily as a separate connection-style read to avoid polluting main attach state.
  // We'll attach under a temp alias and detach immediately.
  const alias = '_src_pragma_probe'
  db.exec(`ATTACH DATABASE '${srcDbPath.replaceAll("'", "''")}' AS ${alias}`)
  try {
    const row = db.prepare(`PRAGMA ${alias}.${pragma}`).get() as { user_version?: number; [k: string]: unknown }
    return (row?.user_version as number) ?? 0
  } finally {
    db.exec(`DETACH DATABASE ${alias}`)
  }
}

function moveDataDirIfPresent(unpackedDir: string, dataRoot: string, name: string): void {
  const src = join(unpackedDir, name)
  if (!existsSync(src)) return
  const dst = join(dataRoot, name)
  if (existsSync(dst)) {
    // Destination dir exists (e.g. server bootstrapped an empty one). Merge: copy contents in.
    mergeIntoDir(src, dst)
    rmSync(src, { recursive: true, force: true })
    return
  }
  // Destination missing — straight rename via cpSync (cross-device safe).
  cpSync(src, dst, { recursive: true })
  rmSync(src, { recursive: true, force: true })
}

function mergeIntoDir(src: string, dst: string): void {
  const entries = readdirSync(src, { withFileTypes: true })
  for (const ent of entries) {
    const s = join(src, ent.name)
    const d = join(dst, ent.name)
    if (ent.isDirectory()) {
      if (!existsSync(d)) {
        cpSync(s, d, { recursive: true })
      } else {
        mergeIntoDir(s, d)
      }
    } else if (ent.isFile()) {
      if (existsSync(d)) {
        // Conflict on a server we declared empty — surface, don't silently overwrite.
        const stat = statSync(d)
        if (stat.size > 0) {
          throw new Error(`File conflict during migration commit: ${d}`)
        }
        cpSync(s, d)
      } else {
        cpSync(s, d)
      }
    }
  }
}

function moveSecretIfPresent(unpackedDir: string, dataRoot: string): void {
  const src = join(unpackedDir, '.secret')
  if (!existsSync(src)) return
  const dst = join(dataRoot, '.secret')
  cpSync(src, dst)
  void chmod(dst, 0o600).catch(() => { /* best-effort on Windows */ })
  rmSync(src, { force: true })
}

function filesInManifest(opts: CommitOptions): { expected: number; present: number; mismatched: string[] } {
  const expected = opts.manifest.files.length
  let present = 0
  for (const entry of opts.manifest.files) {
    if (existsSync(join(opts.unpackedDir, entry.path))) present += 1
  }
  return { expected, present, mismatched: [] }
}
