/**
 * Auto-updater progress, pushed from the Electron main process's updater to the
 * renderer (via the transport `menu` router and the `onUpdateStatus` bridge).
 *
 * Type-only and dependency-free: also the lean
 * `@slayzone/platform/app-update-status` subpath, safe to import from renderer
 * bundles.
 */
export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'not-available' }
  | { type: 'error'; message: string }
