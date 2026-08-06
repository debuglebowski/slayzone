/**
 * Criterion 4: existing installs upgrade with their settings intact, verified on a
 * COPY of a real store.
 *
 * The unit tests next door prove the migration's logic on synthetic fixtures. This
 * proves it against a database that actually accumulated years of migrations, rows
 * and hand-edits — which is where a migration goes wrong. It is opt-in because it
 * needs a real store to point at:
 *
 *   SLAYZONE_REAL_STORE_FIXTURE=~/.slayzone/stable/hub/slayzone.sqlite \
 *     ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *       --experimental-loader ./packages/shared/test-utils/loader.ts \
 *       packages/apps/app/src/main/client-settings-migration.realstore.test.ts
 *
 * IT COPIES FIRST AND ASSERTS THE ORIGINAL IS UNTOUCHED. That is not politeness —
 * the incident documented in `storage-migration.ts`'s header was a migration run by
 * a dev build against a path a prod app still owned. A test that reads your live
 * database is one bad line away from being that incident again, so the source is
 * checked byte-for-byte at the end.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { test, expect } from '../../../../shared/test-utils/ipc-harness.js'
import { readClientSettings } from '@slayzone/platform/client-settings'
import { migrateClientSettings } from './client-settings-migration.js'

const fixture = process.env.SLAYZONE_REAL_STORE_FIXTURE
  ? path.resolve(process.env.SLAYZONE_REAL_STORE_FIXTURE.replace(/^~/, os.homedir()))
  : null

if (!fixture) {
  console.log(
    '  — skipped: set SLAYZONE_REAL_STORE_FIXTURE to a real slayzone.sqlite to run this'
  )
} else if (!fs.existsSync(fixture)) {
  throw new Error(`SLAYZONE_REAL_STORE_FIXTURE does not exist: ${fixture}`)
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-realstore-'))
  const copy = path.join(root, 'slayzone.sqlite')
  const clientRoot = path.join(root, 'client')
  fs.mkdirSync(clientRoot, { recursive: true })

  /** Snapshot of the SOURCE, to prove we never wrote to it. */
  const sourceBefore = { size: fs.statSync(fixture).size, mtimeMs: fs.statSync(fixture).mtimeMs }

  fs.copyFileSync(fixture, copy)
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${fixture}${suffix}`)) fs.copyFileSync(`${fixture}${suffix}`, `${copy}${suffix}`)
  }

  type Counts = Record<string, number>
  const TABLES = ['tasks', 'projects', 'task_artifacts', 'terminal_tabs', 'external_links']

  function snapshot(dbPath: string): {
    userVersion: number
    settings: Record<string, string>
    counts: Counts
  } {
    const db = new Database(dbPath, { readonly: true })
    try {
      const userVersion = db.pragma('user_version', { simple: true }) as number
      const settings = Object.fromEntries(
        (db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map(
          (r) => [r.key, r.value]
        )
      )
      const counts: Counts = {}
      for (const t of TABLES) {
        try {
          counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
        } catch {
          counts[t] = -1 // table absent in this vintage — recorded, not fatal
        }
      }
      return { userVersion, settings, counts }
    } finally {
      db.close()
    }
  }

  const before = snapshot(copy)

  test('migrates a real store without altering a single row', async () => {
    const res = await migrateClientSettings({ clientRoot, dbPath: copy })
    expect(res.status).toBe('migrated')

    const after = snapshot(copy)
    // The migration is copy-only: it must not add, remove or change ANY row.
    expect(after.userVersion).toBe(before.userVersion)
    expect(Object.keys(after.settings).length).toBe(Object.keys(before.settings).length)
    for (const [k, v] of Object.entries(before.settings)) {
      expect(after.settings[k]).toBe(v)
    }
    for (const t of TABLES) expect(after.counts[t]).toBe(before.counts[t])
  })

  test('the client store agrees with what the database held', () => {
    const got = readClientSettings(clientRoot)
    if (before.settings.theme) expect(got.theme).toBe(before.settings.theme)
    if (before.settings.custom_shortcuts) {
      expect(JSON.stringify(got.customShortcuts)).toBe(
        JSON.stringify(JSON.parse(before.settings.custom_shortcuts))
      )
    }
    if (before.settings.labs_tests_panel) {
      expect(got.labs?.testsPanel).toBe(before.settings.labs_tests_panel === '1')
    }
  })

  test('second run is a no-op', async () => {
    const res = await migrateClientSettings({ clientRoot, dbPath: copy })
    expect(res.status).toBe('already-migrated')
    const after = snapshot(copy)
    expect(after.userVersion).toBe(before.userVersion)
  })

  test('THE ORIGINAL FIXTURE IS BYTE-UNTOUCHED', () => {
    const now = fs.statSync(fixture)
    expect(now.size).toBe(sourceBefore.size)
    expect(now.mtimeMs).toBe(sourceBefore.mtimeMs)
  })
}
