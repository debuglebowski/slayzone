import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getDbName } from '@slayzone/platform'
import { updateJsonFile } from '@slayzone/platform/slayzone-config'
import { copyDbTriplet, copyFileIfPresent, mergeMissingFiles } from './copy-utils'

/**
 * One-time COPY of the desktop app's state from the legacy FLAT, shared
 * `~/.slayzone` root into the new channel-scoped roots
 * (`~/.slayzone/<dev|stable>/hub`, `~/.slayzone/<dev|stable>/runner`).
 *
 * ── The legacy root is treated as STRICTLY READ-ONLY, same rule as
 * `storage-migration.ts` and for the identical reason: dev/beta/stable all
 * currently share that one flat root, so an old, not-yet-updated build could
 * still be live and writing to it while a newer build runs this migration.
 * Deleting/moving the source out from under a still-running peer is exactly
 * the incident that already happened once (see `storage-migration.ts`'s file
 * header) — so this migration NEVER calls `rm`/`rename`/`unlink` on
 * `legacyRoot`, only copies out of it.
 *
 * ── Two independent slices, two independent sentinels — hub state and runner
 * state move to two DIFFERENT destination roots, so each gets its own
 * per-channel completion marker and neither slice blocks the other.
 *
 * ── The runner slice is a TRANSFORM, not a directory copy: today's per-hub
 * credential files (`<legacyRoot>/runners/<hub-host>.json`) become entries in
 * one shared map file (`<runnerRoot>/runner.state.json`), matching the
 * consolidation `credential-store.ts` already does for new writes.
 */

/** Per-channel completion sentinel — one per destination root, so the hub and
 *  runner slices (different destinations) never gate on each other. */
function sentinelPath(destRoot: string): string {
  return join(destRoot, '.channel-migrated')
}

/** Mirrors `storage-migration.ts`'s channel→backup-prefix mapping (not
 *  extracted — small, channel-specific, not worth a shared dependency for). */
function channelBackupPrefix(packaged: boolean): string {
  return packaged ? 'slayzone' : 'slayzone.dev'
}

/** Copy the 2 most-recent backups OF THIS CHANNEL from the legacy shared
 *  `storage/backups/` into `<hubRoot>/backups`. Same shape as
 *  `storage-migration.ts`'s `copyRecentBackups` — reimplemented here in terms
 *  of the shared `copyDbTriplet` primitive rather than imported, since a
 *  backup file IS a DB triplet (main + `-wal` + `-shm`) under a different name. */
function copyRecentBackups(legacyStorageDir: string, hubRoot: string, packaged: boolean): void {
  const srcBackups = join(legacyStorageDir, 'backups')
  if (!existsSync(srcBackups)) return
  const dstBackups = join(hubRoot, 'backups')
  const prefix = channelBackupPrefix(packaged)
  // Dev prefix `slayzone.dev` is also a prefix of prod names, so match on the exact
  // `<prefix>.<timestamp>` shape: prod = `slayzone.NNNN-`, dev = `slayzone.dev.NNNN-`.
  const re = new RegExp(`^${prefix.replace('.', '\\.')}\\.\\d{4}-.*\\.sqlite$`)

  const recent = readdirSync(srcBackups)
    .filter((f) => re.test(f))
    .sort()
    .slice(-2)
  if (recent.length === 0) return

  mkdirSync(dstBackups, { recursive: true })
  for (const name of recent) copyDbTriplet(srcBackups, dstBackups, name)
}

/** Copy a single loose file old→new, but only when the destination doesn't
 *  already exist — same "never clobber" invariant every other copy in this
 *  migration follows (copyDbTriplet, copyRecentBackups, mergeMissingFiles all
 *  skip an existing dest). Matters here because a crash between this copy and
 *  the sentinel write would otherwise let a retry stomp on something the app
 *  already wrote into the new location in between. */
function copyFileIfPresentAndAbsent(src: string, dst: string): void {
  if (existsSync(dst)) return
  copyFileIfPresent(src, dst)
}

/**
 * Hub slice: DB triplet, blobs/, artifacts/, this channel's 2 most-recent
 * backups, and the loose `boot-config.json` + `hub-tokens.json` files (real
 * user state — multi-hub federation tokens, server-mode settings — that
 * `storage-migration.ts`'s explicit scope never included, since that
 * migration predates both files). Copy-only, sentinel-gated.
 */
function migrateHubSlice(legacyRoot: string, hubRoot: string, packaged: boolean): void {
  mkdirSync(hubRoot, { recursive: true })
  const sentinel = sentinelPath(hubRoot)
  if (existsSync(sentinel)) return

  const legacyStorageDir = join(legacyRoot, 'storage')
  if (existsSync(legacyStorageDir)) {
    copyDbTriplet(legacyStorageDir, hubRoot, getDbName(packaged))
    for (const name of ['blobs', 'artifacts']) {
      const src = join(legacyStorageDir, name)
      if (existsSync(src)) mergeMissingFiles(src, join(hubRoot, name))
    }
    copyRecentBackups(legacyStorageDir, hubRoot, packaged)
    copyFileIfPresentAndAbsent(
      join(legacyStorageDir, 'boot-config.json'),
      join(hubRoot, 'boot-config.json')
    )
    copyFileIfPresentAndAbsent(
      join(legacyStorageDir, 'hub-tokens.json'),
      join(hubRoot, 'hub-tokens.json')
    )
  }

  writeFileSync(sentinel, new Date().toISOString())
}

/**
 * Runner slice: read every legacy per-hub credential file
 * (`<legacyRoot>/runners/<hub-host>.json`) and merge each one in as a key of
 * the new shared `<runnerRoot>/runner.state.json` map — via the same
 * `updateJsonFile` atomic-merge primitive `slayzone-config.ts` already uses,
 * not a bespoke write path. A malformed legacy file is skipped (logged, not
 * thrown) rather than aborting the whole migration over one bad entry.
 */
function migrateRunnerSlice(legacyRoot: string, runnerRoot: string): void {
  mkdirSync(runnerRoot, { recursive: true })
  const sentinel = sentinelPath(runnerRoot)
  if (existsSync(sentinel)) return

  const legacyRunnersDir = join(legacyRoot, 'runners')
  if (existsSync(legacyRunnersDir)) {
    const stateFilePath = join(runnerRoot, 'runner.state.json')
    for (const entry of readdirSync(legacyRunnersDir)) {
      if (!entry.endsWith('.json')) continue
      const hubHost = basename(entry, '.json')
      try {
        const credentials: unknown = JSON.parse(
          readFileSync(join(legacyRunnersDir, entry), 'utf8')
        )
        updateJsonFile({ [hubHost]: credentials }, stateFilePath)
      } catch (err) {
        console.error(
          `[channel-storage-migration] skipping unreadable legacy credential file ${entry}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  writeFileSync(sentinel, new Date().toISOString())
}

/**
 * COPY (never move) the desktop app's state from the legacy flat
 * `~/.slayzone` into the new channel-scoped hub/runner roots. Idempotent
 * (per-slice sentinels) and safe to call on every boot — a fresh install with
 * no legacy state just creates the destination dirs and marks both slices done.
 *
 * `run/sidecar.sock` is deliberately NOT migrated — it's ephemeral, recreated
 * fresh on every boot, and carries no persistent state to preserve.
 */
export function ensureChannelScopedStorage(opts: {
  legacyRoot: string
  hubRoot: string
  runnerRoot: string
  packaged: boolean
}): void {
  migrateHubSlice(opts.legacyRoot, opts.hubRoot, opts.packaged)
  migrateRunnerSlice(opts.legacyRoot, opts.runnerRoot)
}
