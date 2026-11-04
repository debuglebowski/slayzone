import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  getDbName,
  getDiagnosticsDbName,
  getLegacyDbName,
  getStorageDir,
  type SlayzoneDb
} from '@slayzone/platform'
import { openSqliteWorker } from '@slayzone/platform/sqlite-worker'

/**
 * Resolves the SQLite path the side-car should open — DERIVED from the storage
 * dir, identically in every mode. `getStorageDir()` returns `<ROOT>/storage`
 * (from SLAYZONE_ROOT), the SAME dir the Electron host + standalone entrypoint
 * derive; the filename is dev-vs-packaged (`SLAYZONE_DEV`). No file-pointing var
 * exists to thread across the process boundary — supervised and standalone both
 * compute the same path from ROOT, so there is no two-DB-split risk to guard.
 */
export function getDatabasePathFromEnv(): string {
  const name = getDbName(process.env.SLAYZONE_DEV !== '1')
  return path.join(getStorageDir(), name)
}

/** What `db-worker.ts` needs to open the data DB. Resolved HERE, from env, at open time. */
export type HubDataDbWorkerData = {
  storageDir: string
  dbPath: string
  dbName: string
  legacyDbName: string
  backupsDir: string
  backupFilePrefix: string
}

/** What `diag-worker.ts` needs to open the diagnostics DB. */
export type HubDiagnosticsDbWorkerData = { dbPath: string }

/**
 * Where a worker entry lives: beside the running bundle. `build.mjs` emits
 * `db-worker.cjs` + `diag-worker.cjs` next to `bin.cjs` in `dist/`, and every way
 * the hub ships keeps them together (packaged: `resources/hub/`; npm: the
 * package's `dist/`). Run from TS source (tests: `src/db.ts`) nothing is beside
 * this file, so it falls back to the same `../dist` offset `WEB_ROOT` uses — the
 * built entry, which the test harness's globalSetup rebuilds before any suite.
 * `__dirname`, never `import.meta` (empty in the CJS bundle — see server.ts).
 */
function workerEntryPath(file: 'db-worker.cjs' | 'diag-worker.cjs'): string {
  const besideBundle = path.join(__dirname, file)
  if (existsSync(besideBundle)) return besideBundle
  const builtFromSource = path.join(__dirname, '..', 'dist', file)
  if (existsSync(builtFromSource)) return builtFromSource
  throw new Error(
    `hub DB worker entry ${file} not found (looked in ${besideBundle} and ${builtFromSource}) — ` +
      'build the hub (node packages/apps/hub/build.mjs); packaging must ship it beside bin.cjs'
  )
}

/**
 * A DB worker that dies after startup (out of memory, an uncaught throw) leaves a
 * hub that answers every request with an error. In-process, the same failure took
 * the whole process down and the supervisor restarted it — so escalate to exactly
 * that: rethrow on the hub's thread, where it is an uncaught exception.
 */
function crashHub(err: Error): void {
  process.nextTick(() => {
    throw err
  })
}

/**
 * Open the shared DB and bring its schema up to date. THE HUB OWNS THE SCHEMA IN
 * EVERY MODE — there is deliberately no option to skip this.
 *
 * It used to take `{ bootstrapSchema: !supervised }`: a supervised hub opened the
 * Electron host's already-migrated file and was forbidden to touch the schema,
 * because the host's DB worker got there first. That is one file with two writers,
 * one of them told not to touch the schema — and it forced the host to migrate
 * even in REMOTE mode, where it carries a local copy of a schema whose data lives
 * on the server. Removing the parameter makes the special-case unrepresentable
 * rather than merely unused.
 *
 * The connection lives on a worker thread (`db-worker.ts`). better-sqlite3 is
 * synchronous: on the hub's only thread a long query — or a long run of short ones,
 * since every `await db.x()` resolved as a microtask and never yielded — froze all
 * WS/tRPC traffic (event-loop stalls of 2–10s; task tabs missed their 20s load
 * deadline). The worker runs the whole bring-up — rename adoption, pragmas, the
 * pre-migration backup and the schema bootstrap, on the one connection, so no
 * caller can interleave between backup and migration — and this resolves once it
 * finished; a startup failure rejects with that error (message + SQLite code).
 */
export function openServerDatabase(): Promise<SlayzoneDb> {
  const dev = process.env.SLAYZONE_DEV === '1'
  const storageDir = getStorageDir()
  const dbName = getDbName(!dev)
  const data: HubDataDbWorkerData = {
    storageDir,
    dbPath: getDatabasePathFromEnv(),
    dbName,
    legacyDbName: getLegacyDbName(!dev),
    backupsDir: path.join(storageDir, 'backups'),
    // Same derivation as the DB path itself, so the backup can never be named for
    // a different channel than the file it backs up.
    backupFilePrefix: dbName.replace(/\.sqlite$/, '')
  }
  return openSqliteWorker({
    label: 'the hub data DB worker',
    workerPath: workerEntryPath('db-worker.cjs'),
    workerData: data,
    onUnexpectedExit: crashHub
  })
}

/**
 * Path of the diagnostics events DB. Named explicitly, NOT derived from the main
 * DB's name: that would now yield `slayzone.data.diagnostics.sqlite`, a second
 * diagnostics DB beside the real one.
 */
export function getServerDiagnosticsDatabasePath(): string {
  return path.join(getStorageDir(), getDiagnosticsDbName(process.env.SLAYZONE_DEV !== '1'))
}

/**
 * Open the separate diagnostics events DB (`slayzone[.dev].diagnostics.sqlite`,
 * sibling of the main `slayzone[.dev].data.sqlite`). The sidecar owns pty + the agent pool, so its
 * `recordDiagnosticEvent` calls must persist HERE — otherwise they buffer and
 * drop (the events DB was only ever bound in the Electron host, so sidecar
 * diagnostics were invisible). WAL + busy_timeout (DB_PRAGMAS) make the two-process
 * (host + sidecar) writers safe; the schema is now literally shared rather than
 * "mirrored", which is what let the two drift.
 *
 * In its OWN worker (`diag-worker.ts`), not the data DB's: diagnostics writes never
 * share a connection or a queue with task/settings data.
 */
export function openServerDiagnosticsDatabase(): Promise<SlayzoneDb> {
  const data: HubDiagnosticsDbWorkerData = { dbPath: getServerDiagnosticsDatabasePath() }
  return openSqliteWorker({
    label: 'the hub diagnostics DB worker',
    workerPath: workerEntryPath('diag-worker.cjs'),
    workerData: data,
    onUnexpectedExit: crashHub
  })
}
