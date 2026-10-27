/**
 * The whole migration chain, v145 → latest, must not lose a ROW.
 *
 * v145 is what v0.35.0 leaves on disk. Most migrations have no test with old-style rows
 * (v152–155, v158, v159 had none), and the ones that do test one slice. This is the
 * blunt, future-proof check instead: seed every table of a real v145 database with rows,
 * run every migration, and require that every seeded table still exists with at least the
 * rows it had — unless it is on the explicit renamed/retired list below, in which case the
 * rows must have followed it. A migration that rebuilds a table and forgets a row, or one
 * that drops a table without a successor, fails here by name.
 *
 * Rows are synthesized from the schema itself (`PRAGMA table_info` / `foreign_key_list`),
 * so a table added to v145 tomorrow is covered without touching this file. A table whose
 * constraints a synthesized row cannot satisfy (a CHECK on an enum) is reported and
 * skipped, never silently: the test also requires the tables that matter most were seeded.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/transport/src/db-bootstrap/v145-chain-conserves-rows.test.ts
 */
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrations, runMigrations } from './index'

const LATEST = migrations[migrations.length - 1].version

/**
 * Tables that do not exist under their v145 name at latest, with where their rows went.
 * Adding to this list is a statement that a rename/retirement is intended — say why.
 */
const SUCCESSOR: Record<string, string> = {
  runners: 'computers' // v163: runner → computer rename
}

/** Columns a synthesized value cannot satisfy (CHECK on an enum): fixed by hand. */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  task_conversations: { origin: 'slay-spawned-fresh', mode: 'claude-code' }
}

/** Tables that must be seeded, or the test proves nothing. */
const MUST_SEED = ['projects', 'tasks', 'task_conversations', 'settings']

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
type Fk = { from: string; table: string; to: string | null }

function dbAtV145(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.version > 145) break
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return db
}

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`

/** Seed `rowsPerTable` rows into every table; parents first. Returns counts + skips. */
function seedEverything(
  db: Database.Database,
  rowsPerTable = 2
): { seeded: Map<string, number>; skipped: Map<string, string> } {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name)
  const fks = new Map<string, Fk[]>(
    tables.map((t) => [t, db.pragma(`foreign_key_list(${q(t)})`) as Fk[]])
  )

  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (t: string): void => {
    if (state.has(t)) return
    state.set(t, 'visiting')
    for (const fk of fks.get(t) ?? [])
      if (fk.table !== t && tables.includes(fk.table)) visit(fk.table)
    state.set(t, 'done')
    order.push(t)
  }
  tables.forEach(visit)

  const seeded = new Map<string, number>()
  const skipped = new Map<string, string>()
  // Two passes: a foreign-key CYCLE (task_artifacts ↔ artifact_versions) has no parents-
  // first order, so a table that was skipped for want of a parent gets one retry.
  for (const t of [...order, ...order]) {
    if (seeded.has(t)) continue
    const cols = db.pragma(`table_info(${q(t)})`) as Col[]
    const tableFks = fks.get(t) ?? []
    let inserted = 0
    for (let i = 1; i <= rowsPerTable; i++) {
      const names: string[] = []
      const values: unknown[] = []
      let satisfiable = true
      for (const c of cols) {
        const fk = tableFks.find((f) => f.from === c.name)
        if (fk) {
          const parentCols = db.pragma(`table_info(${q(fk.table)})`) as Col[]
          const target = fk.to ?? parentCols.find((p) => p.pk === 1)?.name
          const parent = target
            ? ((db
                .prepare(`SELECT ${q(target)} AS v FROM ${q(fk.table)} LIMIT 1 OFFSET ?`)
                .get(i - 1) as { v: unknown } | undefined) ??
              (db.prepare(`SELECT ${q(target)} AS v FROM ${q(fk.table)} LIMIT 1`).get() as
                | { v: unknown }
                | undefined))
            : undefined
          if (parent) {
            names.push(q(c.name))
            values.push(parent.v)
          } else if (c.notnull) satisfiable = false
          continue
        }
        const fixed = OVERRIDES[t]?.[c.name]
        // Optional, defaulted columns stay at their default: keeps CHECKs satisfied.
        if (fixed === undefined && !c.pk && (!c.notnull || c.dflt_value !== null)) continue
        names.push(q(c.name))
        values.push(fixed ?? (/INT|REAL|NUM|BOOL/i.test(c.type) ? i : `${t}-${c.name}-${i}`))
      }
      if (!satisfiable) {
        skipped.set(t, 'a required parent table has no rows')
        break
      }
      try {
        db.prepare(
          `INSERT INTO ${q(t)} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`
        ).run(...values)
        inserted++
      } catch (err) {
        skipped.set(t, err instanceof Error ? err.message : String(err))
        break
      }
    }
    if (inserted > 0) {
      seeded.set(t, inserted)
      skipped.delete(t)
    }
  }
  return { seeded, skipped }
}

const count = (db: Database.Database, t: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${q(t)}`).get() as { n: number }).n

describe('v145 → latest conserves every row', () => {
  // One database shared by the tests below, in order: seed at v145, migrate, inspect.
  let db: Database.Database
  let seeded: Map<string, number>

  beforeAll(() => {
    db = dbAtV145()
    const result = seedEverything(db)
    seeded = result.seeded
    console.log(`  (seeded ${seeded.size} tables, skipped ${result.skipped.size})`)
    for (const [t, why] of result.skipped) console.log(`    skipped ${t}: ${why}`)
  })

  afterAll(() => {
    db?.close()
  })

  test('the tables that matter most were actually seeded', () => {
    const missing = MUST_SEED.filter((t) => !seeded.has(t))
    expect(missing).toEqual([])
  })

  test('the full chain applies to latest', () => {
    runMigrations(db)
    const v = db.pragma('user_version', { simple: true })
    expect(v).toBe(LATEST)
  })

  test('no seeded table lost a row (or vanished without a successor)', () => {
    const finalTables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((r) => r.name)
    )
    const problems: string[] = []
    for (const [t, n] of seeded) {
      const home = finalTables.has(t) ? t : SUCCESSOR[t]
      if (!home || !finalTables.has(home)) {
        problems.push(`${t}: table is gone and not on the successor list`)
        continue
      }
      const now = count(db, home)
      if (now < n)
        problems.push(`${t}${home === t ? '' : ` → ${home}`}: ${n} rows seeded, ${now} left`)
    }
    expect(problems).toEqual([])
  })

  test('integrity_check ok and no foreign-key violations', () => {
    const integrity = db.pragma('integrity_check', { simple: true })
    expect(integrity).toBe('ok')
    const violations = db.pragma('foreign_key_check') as unknown[]
    expect(violations).toEqual([])
  })
})
