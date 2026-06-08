import { BrowserWindow } from 'electron'
import { artifactWatcherEvents } from '../server/artifact-watcher'

/**
 * Legacy IPC bridge for artifact content changes.
 *
 * The pure file watcher (server/artifact-watcher.ts) emits `content-changed` on
 * `artifactWatcherEvents`. This Electron-only subscriber mirrors each change onto
 * the legacy `artifacts:content-changed` webContents.send channel so renderers
 * still on IPC refresh. Deleted when the renderer drops IPC (slice 5).
 *
 * Idempotent: invoke once at app boot (replaces the former module-level
 * side-effect in main/artifact-watcher.ts).
 */
let wired = false

export function initArtifactWatcherBroadcast(): void {
  if (wired) return
  wired = true
  artifactWatcherEvents.on('content-changed', (artifactId) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      w.webContents.send('artifacts:content-changed', artifactId)
    }
  })
}
