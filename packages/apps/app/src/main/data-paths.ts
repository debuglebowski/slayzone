import { getSlayzoneHomeDir, getSupervisedRoot } from '@slayzone/platform'
import { ensureChannelScopedStorage } from './channel-storage-migration'
import { dirname, join } from 'node:path'
import { ensureStorageDir } from './storage-migration'
import { migrateLegacyDatabaseIfNeeded } from './db/legacy-migration'

/**
 * The desktop app's storage dir = its CHANNEL-SCOPED HUB ROOT,
 * `~/.slayzone/<dev|stable>/hub` (platform `getSupervisedRoot('hub')`), flat —
 * no `storage/` nesting layer, since that root now belongs to exactly one role.
 *
 * The app main process plays the HUB role: it owns the DB, artifacts, blobs,
 * backups and sidecar logs. Its co-located local runner gets its OWN root
 * (`getSupervisedRoot('runner')`), handed over explicitly at spawn time in
 * `index.ts` — the two used to silently share one ambient root, which is how a
 * runner-owned `runners/` dir ended up loose inside the hub's own state.
 *
 * `getSupervisedRoot` reads `SLAYZONE_RELEASE_CHANNEL`, so the channel MUST be
 * derived (in `index.ts`) before anything in this module is called.
 *
 * Two independent one-time COPY migrations feed this dir, both copy-only:
 *  1. legacy flat `~/.slayzone/storage` → this channel-scoped root
 *     (`channel-storage-migration.ts`)
 *  2. legacy Electron userData → this root (`storage-migration.ts`)
 * Order matters — see `initStorageDir`.
 */

/**
 * Run both one-time COPY migrations of legacy state into the channel-scoped hub
 * root, then return that dir. Call once at boot before the DB opens.
 *
 * `legacyStateDir` is the pre-profile-swap Electron userData (migration #2's
 * SOURCE — read-only, since a pre-refactor peer app may share it). `packaged`
 * scopes both copies to this channel's DB (`app.isPackaged`): prod copies
 * `slayzone.sqlite`, dev copies the `.dev` DB.
 *
 * ORDER IS LOAD-BEARING: the channel migration runs FIRST. Both migrations skip
 * a DB copy when the destination already exists, so running the userData one
 * first would plant its (potentially years-old) DB in the fresh channel root and
 * make the channel migration skip the user's ACTUAL current database sitting in
 * `~/.slayzone/storage`. Newest source wins by going first.
 */
export function initStorageDir(legacyStateDir: string, packaged: boolean): string {
  const target = getSupervisedRoot('hub')
  ensureChannelScopedStorage({
    // Migration SOURCE, strictly read-only: the pre-channel-scoping flat root,
    // where the old shared layout kept `storage/` and `runners/`.
    legacyRoot: getSlayzoneHomeDir(),
    hubRoot: target,
    runnerRoot: getSupervisedRoot('runner'),
    packaged
  })
  // omgslayzone → userData. MOVED HERE from the DB worker, which ran it AFTER
  // `ensureStorageDir` below had already migrated userData into the channel root
  // and written its sentinel — so on an omgslayzone-era upgrade the legacy DB
  // landed in userData and was stranded there permanently. Ordering: the channel
  // migration is the newest source and goes first; this must land in userData
  // BEFORE the userData→root step reads it. `copyDbTriplet` skips an existing
  // destination, so step 3 correctly no-ops when step 1 already planted a DB.
  migrateLegacyDatabaseIfNeeded({
    oldUserData: join(dirname(legacyStateDir), 'omgslayzone'),
    newUserData: legacyStateDir
  })
  ensureStorageDir(legacyStateDir, target, packaged)
  return target
}

/** The resolved channel-scoped hub root. Same value the sidecar derives from the
 *  `SLAYZONE_ROOT` this app hands it explicitly at spawn (`index.ts`). */
export function getStorageDir(): string {
  return getSupervisedRoot('hub')
}
