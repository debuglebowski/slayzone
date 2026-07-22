import { getStorageDir as platformStorageDir } from '@slayzone/platform'
import { ensureStorageDir } from './storage-migration'

/**
 * The app's storage dir = `<SLAYZONE_ROOT>/storage` (platform-derived), migrated
 * once out of the legacy Electron userData location. `SLAYZONE_ROOT` is the ONLY
 * env var in this chain — the app, the sidecar it spawns, and the hub all derive
 * the same `<ROOT>/storage` from it, so there is no `SLAYZONE_STORE_DIR` /
 * `SLAYZONE_DB_PATH` handoff to thread across the process boundary.
 *
 * `getStorageDir()` (platform) resolves the same path in any process; this module
 * only adds the boot-time one-shot migration of legacy data into it.
 */

/**
 * Run the one-time COPY of legacy state (Electron userData) into `<ROOT>/storage`,
 * then return that dir. Call once at boot before the DB opens. `legacyStateDir` is
 * the pre-profile-swap userData (the copy SOURCE — treated as read-only, since a
 * pre-refactor peer app may share it). `packaged` scopes the copy to this channel's
 * DB (`app.isPackaged`): prod copies `slayzone.sqlite`, dev copies the `.dev` DB.
 */
export function initStorageDir(legacyStateDir: string, packaged: boolean): string {
  const target = platformStorageDir()
  ensureStorageDir(legacyStateDir, target, packaged)
  return target
}

/** The resolved `<ROOT>/storage` dir. Same value platform derives everywhere. */
export function getStorageDir(): string {
  return platformStorageDir()
}
