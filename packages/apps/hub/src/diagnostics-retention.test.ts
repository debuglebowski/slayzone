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
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/apps/hub/src/diagnostics-retention.test.ts
 */
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

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

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

async function main(): Promise<void> {
  const { startServer } = await import('./server.js')
  const { getServerDiagnosticsDatabasePath } = await import('./db.js')
  const { runScheduledRetentionNow } = await import('@slayzone/diagnostics/server')

  console.log('unsupervised hub — owns retention')
  {
    const { blobDir } = prepareHub(false)
    const { oldBlob, freshBlob } = seedBlobs(blobDir)
    const handle = await startServer()
    const db = seedRows(getServerDiagnosticsDatabasePath())

    await test('a retention pass prunes expired rows and blobs, keeps fresh ones', async () => {
      assert((await runScheduledRetentionNow()) === true, 'the hub runs a retention scheduler')
      assert(!rowExists(db, 'row-old'), 'expired row pruned')
      assert(rowExists(db, 'row-fresh'), 'fresh row kept')
      assert(!existsSync(oldBlob), 'expired blob pruned')
      assert(existsSync(freshBlob), 'fresh blob kept')
    })

    db.close()
    await handle.stop()

    await test('stopping the hub stops its scheduler', async () => {
      assert((await runScheduledRetentionNow()) === false, 'no scheduler after stop')
    })
  }

  console.log('supervised hub — the desktop host owns retention')
  {
    const { blobDir } = prepareHub(true)
    const { oldBlob } = seedBlobs(blobDir)
    const handle = await startServer()

    await test('runs no scheduler and leaves the shared blobs alone', async () => {
      assert((await runScheduledRetentionNow()) === false, 'no scheduler in a supervised hub')
      assert(existsSync(oldBlob), 'the host, not this hub, prunes the shared blob dir')
    })

    await handle.stop()
  }

  for (const root of roots) rmSync(root, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
