/**
 * Schema ownership: the hub migrates in EVERY mode, supervised included.
 *
 * THE SPLIT THIS CLOSES: `openServerDatabase({ bootstrapSchema: !supervised })`
 * meant a supervised hub opened the Electron host's already-migrated file and
 * was forbidden to touch the schema — because the host's DB worker got there
 * first. One file, two writers, one of them told not to touch the schema. That
 * arrangement also forced the host to migrate in REMOTE mode, where it carries a
 * local copy of a schema whose data lives on the server.
 *
 * So `openServerDatabase()` now bootstraps unconditionally, and the supervised
 * special-case is gone structurally: there is no option left to pass. `supervised`
 * still gates the sidecar socket and the mode/bind hardening — just not the schema.
 *
 * Safe to run alongside the host's own migrator during the transition: every
 * migration is `user_version`-gated and atomic with its own version bump
 * (`migrations.ts` runMigrations), so a second caller is a no-op and a crash
 * mid-migration cannot half-apply. Case 2 pins that.
 *
 * Native ABI (better-sqlite3) → Electron strict loader, same as the other hub
 * DB tests.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/supervised-bootstrap.test.ts
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../../../shared/test-utils/ipc-harness.js'
import { LATEST_MIGRATION_VERSION } from '@slayzone/transport/db-bootstrap'
import { openServerDatabase, openServerDiagnosticsDatabase } from './db.js'

const ROOT_KEY = 'SLAYZONE_ROOT'
const SUPERVISED_KEY = 'SLAYZONE_SUPERVISED'
const priorRoot = process.env[ROOT_KEY]
const priorSupervised = process.env[SUPERVISED_KEY]

/**
 * A throwaway store, opened the way a SUPERVISED hub opens one.
 *
 * MUST await `fn` before the finally block runs: an earlier sync version tore
 * the dir down and restored the env while the body was still awaiting, so the
 * second open landed on a different (ambient) store and reported a bogus version.
 */
async function withEmptyStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'slayzone-supervised-bootstrap-'))
  // Both are read at call time, not import time — the hub derives its DB path
  // from ROOT and nothing else (no file-pointing var exists to thread).
  process.env[ROOT_KEY] = dir
  process.env[SUPERVISED_KEY] = '1'
  try {
    return await fn(dir)
  } finally {
    if (priorRoot === undefined) delete process.env[ROOT_KEY]
    else process.env[ROOT_KEY] = priorRoot
    if (priorSupervised === undefined) delete process.env[SUPERVISED_KEY]
    else process.env[SUPERVISED_KEY] = priorSupervised
    rmSync(dir, { recursive: true, force: true })
  }
}

const userVersion = async (db: { get: (sql: string) => Promise<unknown> }): Promise<number> =>
  ((await db.get('PRAGMA user_version')) as { user_version: number }).user_version

const hasTable = async (
  db: { get: (sql: string, p: unknown[]) => Promise<unknown> },
  name: string
): Promise<boolean> =>
  (await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name])) !==
  undefined

await test('supervised hub bootstraps an empty store to the latest schema', async () => {
  await withEmptyStore(async () => {
    const db = await openServerDatabase()
    try {
      expect(await userVersion(db)).toBe(LATEST_MIGRATION_VERSION)
      expect(await hasTable(db, 'tasks')).toBe(true)
      expect(await hasTable(db, 'settings')).toBe(true)
    } finally {
      await db.close()
    }
  })
})

await test('a second open is a no-op — no re-migration, no error', async () => {
  await withEmptyStore(async (dir) => {
    const first = await openServerDatabase()
    const after = await userVersion(first)
    await first.close()

    const second = await openServerDatabase()
    try {
      expect(await userVersion(second)).toBe(after)
      expect(await hasTable(second, 'tasks')).toBe(true)
    } finally {
      await second.close()
    }

    // The pre-migration backup self-skips once currentVersion >= target, so a
    // re-open must not mint a second one. Guards against a backup-per-boot leak
    // now that the hub — not the host — owns that step.
    const backups = readdirSync(dir).filter((f) => f.includes('.migration.'))
    expect(backups.length <= 1).toBe(true)
  })
})

// --- the main DB was renamed slayzone.sqlite → slayzone.data.sqlite -------------------
// A beta hub root (and a standalone hub root) still holds the old name. The hub must
// adopt it BEFORE opening, or it would create a fresh empty database beside the real one
// and the user would see all their data gone.

const DEV_KEY = 'SLAYZONE_DEV'

async function withDevFlag<T>(dev: boolean, fn: () => Promise<T>): Promise<T> {
  const prior = process.env[DEV_KEY]
  if (dev) process.env[DEV_KEY] = '1'
  else delete process.env[DEV_KEY]
  try {
    return await fn()
  } finally {
    if (prior === undefined) delete process.env[DEV_KEY]
    else process.env[DEV_KEY] = prior
  }
}

/** Build a real store at the NEW name, put a marker row in it, then rename it back to
 *  the legacy name — exactly what a beta hub root looks like. */
async function makeLegacyStore(dir: string, legacyName: string, newName: string): Promise<void> {
  const db = await openServerDatabase()
  await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('marker', 'survived')")
  await db.close()
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(join(dir, newName + suffix))) {
      renameSync(join(dir, newName + suffix), join(dir, legacyName + suffix))
    }
  }
}

const marker = async (db: {
  get: (sql: string) => Promise<unknown>
}): Promise<string | undefined> =>
  (
    (await db.get("SELECT value FROM settings WHERE key = 'marker'")) as
      | { value: string }
      | undefined
  )?.value

for (const [dev, legacyName, newName] of [
  [false, 'slayzone.sqlite', 'slayzone.data.sqlite'],
  [true, 'slayzone.dev.sqlite', 'slayzone.dev.data.sqlite']
] as const) {
  await test(`a beta store named ${legacyName} is adopted as ${newName} with its data`, async () => {
    await withDevFlag(dev, () =>
      withEmptyStore(async (dir) => {
        await makeLegacyStore(dir, legacyName, newName)
        expect(existsSync(join(dir, legacyName))).toBe(true)
        expect(existsSync(join(dir, newName))).toBe(false)

        const db = await openServerDatabase()
        try {
          expect(await marker(db)).toBe('survived')
          expect(await userVersion(db)).toBe(LATEST_MIGRATION_VERSION)
        } finally {
          await db.close()
        }
        expect(existsSync(join(dir, newName))).toBe(true)
        expect(existsSync(join(dir, legacyName))).toBe(false)
      })
    )
  })
}

await test('a store that already has the new name is left alone (no second database)', async () => {
  await withEmptyStore(async (dir) => {
    const first = await openServerDatabase()
    await first.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('marker', 'current')")
    await first.close()
    writeFileSync(join(dir, 'slayzone.sqlite'), 'STALE-OLD-FILE')
    const db = await openServerDatabase()
    try {
      expect(await marker(db)).toBe('current')
    } finally {
      await db.close()
    }
    expect(readFileSync(join(dir, 'slayzone.sqlite'), 'utf8')).toBe('STALE-OLD-FILE')
  })
})

await test('the diagnostics DB keeps its own name (not slayzone.data.diagnostics.sqlite)', async () => {
  for (const [dev, expected] of [
    [false, 'slayzone.diagnostics.sqlite'],
    [true, 'slayzone.dev.diagnostics.sqlite']
  ] as const) {
    await withDevFlag(dev, () =>
      withEmptyStore(async (dir) => {
        const diag = openServerDiagnosticsDatabase()
        await diag.close()
        const files = readdirSync(dir)
        expect(files.includes(expected)).toBe(true)
        expect(files.some((f) => f.includes('.data.diagnostics'))).toBe(false)
      })
    )
  }
})
