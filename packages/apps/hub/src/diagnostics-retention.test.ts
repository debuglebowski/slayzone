/**
 * A hub that is not the desktop's prunes its own diagnostics: event rows past
 * `retentionDays` and the payload blobs beside the DB. Only the Electron host ran
 * retention, so a standalone / remote / chromium-fork hub grew both forever.
 *
 * The desktop's SUPERVISED hub must not: it writes the same diagnostics file as its
 * host, which already prunes it — two pruners would race on the same blobs.
 *
 * Real `startServer()` in this process (see owner-checks-harness.ts for why).
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAY_MS = 24 * 60 * 60 * 1000
const roots: string[] = []

/** Fresh env + root for one in-process hub. */
function prepareHub(supervised: boolean): { root: string; blobDir: string } {
  for (const k of Object.keys(process.env)) if (/^SLAYZONE_/.test(k)) delete process.env[k]
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'slz-hub-diag-retention-')))
  roots.push(root)
  mkdirSync(join(root, 'home'))
  Object.assign(process.env, {
    HOME: join(root, 'home'),
    SLAYZONE_ROOT: root,
    SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
    SLAYZONE_HUB_REQUIRE_LOGIN: '0',
    ...(supervised
      ? { SLAYZONE_SUPERVISED: '1' }
      : // What applyStandaloneHubConfig (bin.ts) seeds before a standalone boot.
        { SLAYZONE_HUB_AUTH_SECRET: 'diagnostics-retention-test-secret-0123456789-abcdef' })
  })
  process.chdir(root)
  return { root, blobDir: join(root, 'diagnostics') }
}

/** One blob older than the 14-day default retention, one fresh. */
function seedBlobs(blobDir: string): { oldBlob: string; freshBlob: string } {
  mkdirSync(blobDir, { recursive: true })
  const oldBlob = join(blobDir, 'blob-old.png')
  const freshBlob = join(blobDir, 'blob-fresh.png')
  writeFileSync(oldBlob, Buffer.alloc(16))
  writeFileSync(freshBlob, Buffer.alloc(16))
  const oldSeconds = (Date.now() - 20 * DAY_MS) / 1000
  utimesSync(oldBlob, oldSeconds, oldSeconds)
  return { oldBlob, freshBlob }
}

function seedRows(diagPath: string): Database.Database {
  const db = new Database(diagPath)
  const insert = db.prepare(
    `INSERT INTO diagnostics_events (id, ts_ms, level, source, event) VALUES (?, ?, 'info', 'test', 'test.event')`
  )
  insert.run('row-old', Date.now() - 20 * DAY_MS)
  insert.run('row-fresh', Date.now())
  return db
}

const rowExists = (db: Database.Database, id: string): boolean =>
  db.prepare('SELECT 1 FROM diagnostics_events WHERE id = ?').get(id) !== undefined

// server.ts is written for the CJS bundle (`__dirname`); give its ESM source one.
const g = globalThis as Record<string, unknown>
g.__dirname ??= dirname(fileURLToPath(import.meta.url))

const { startServer } = await import('./server.js')
const { getServerDiagnosticsDatabasePath } = await import('./db.js')
const { runScheduledRetentionNow } = await import('@slayzone/diagnostics/server')

type Handle = Awaited<ReturnType<typeof startServer>>

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('unsupervised hub — owns retention', () => {
  let handle: Handle
  let db: Database.Database
  let oldBlob: string
  let freshBlob: string
  beforeAll(async () => {
    const { blobDir } = prepareHub(false)
    ;({ oldBlob, freshBlob } = seedBlobs(blobDir))
    handle = await startServer()
    db = seedRows(getServerDiagnosticsDatabasePath())
  })

  test('a retention pass prunes expired rows and blobs, keeps fresh ones', async () => {
    expect(await runScheduledRetentionNow(), 'the hub runs a retention scheduler').toBe(true)
    expect(rowExists(db, 'row-old'), 'expired row pruned').toBe(false)
    expect(rowExists(db, 'row-fresh'), 'fresh row kept').toBe(true)
    expect(existsSync(oldBlob), 'expired blob pruned').toBe(false)
    expect(existsSync(freshBlob), 'fresh blob kept').toBe(true)
  })

  test('stopping the hub stops its scheduler', async () => {
    db.close()
    await handle.stop()
    expect(await runScheduledRetentionNow(), 'no scheduler after stop').toBe(false)
  })
})

describe('supervised hub — the desktop host owns retention', () => {
  let handle: Handle
  let oldBlob: string
  beforeAll(async () => {
    const { blobDir } = prepareHub(true)
    ;({ oldBlob } = seedBlobs(blobDir))
    handle = await startServer()
  })
  afterAll(async () => {
    await handle.stop()
  })

  test('runs no scheduler and leaves the shared blobs alone', async () => {
    expect(await runScheduledRetentionNow(), 'no scheduler in a supervised hub').toBe(false)
    expect(existsSync(oldBlob), 'the host, not this hub, prunes the shared blob dir').toBe(true)
  })
})
