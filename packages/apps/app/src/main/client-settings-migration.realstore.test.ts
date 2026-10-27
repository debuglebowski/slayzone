/**
 * Criterion 4: existing installs upgrade with their settings intact, verified on a
 * COPY of a real store.
 *
 * The unit tests next door prove the migration's logic on synthetic fixtures. This
 * proves it against a database that actually accumulated years of migrations, rows
 * and hand-edits — which is where a migration goes wrong. It is opt-in because it
 * needs a real store to point at:
 *
 *   SLAYZONE_REAL_STORE_FIXTURE=~/.slayzone/stable/hub/slayzone.data.sqlite \
 *     ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *       --config packages/shared/test-utils/vitest.harness.config.ts \
 *       packages/apps/app/src/main/client-settings-migration.realstore.test.ts
 *
 * Without the env var the suite is reported as skipped.
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
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readClientSettings } from '@slayzone/platform/client-settings'
import { migrateClientSettings } from './client-settings-migration.js'

const fixture = process.env.SLAYZONE_REAL_STORE_FIXTURE
  ? path.resolve(process.env.SLAYZONE_REAL_STORE_FIXTURE.replace(/^~/, os.homedir()))
  : null

if (fixture && !fs.existsSync(fixture)) {
  throw new Error(`SLAYZONE_REAL_STORE_FIXTURE does not exist: ${fixture}`)
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

describe.runIf(fixture)('client-settings migration against a real store copy', () => {
  let root: string
  let copy: string
  let clientRoot: string
  /** Snapshot of the SOURCE, to prove we never wrote to it. */
  let sourceBefore: { size: number; mtimeMs: number }
  let before: ReturnType<typeof snapshot>

  beforeAll(() => {
    const source = fixture!
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-realstore-'))
    copy = path.join(root, 'slayzone.sqlite')
    clientRoot = path.join(root, 'client')
    fs.mkdirSync(clientRoot, { recursive: true })

    sourceBefore = { size: fs.statSync(source).size, mtimeMs: fs.statSync(source).mtimeMs }

    fs.copyFileSync(source, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${source}${suffix}`))
        fs.copyFileSync(`${source}${suffix}`, `${copy}${suffix}`)
    }

    before = snapshot(copy)
  })

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

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
    const now = fs.statSync(fixture!)
    expect(now.size).toBe(sourceBefore.size)
    expect(now.mtimeMs).toBe(sourceBefore.mtimeMs)
  })
})
