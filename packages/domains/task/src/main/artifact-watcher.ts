import { BrowserWindow } from 'electron'
import {
  artifactWatcherEvents,
  startArtifactWatcher,
  closeArtifactWatcher
} from '../server/artifact-watcher'

// Bridge the electron-free watcher emitter (../server/artifact-watcher) to renderer
// windows via the legacy `artifacts:content-changed` IPC channel. Keeps existing
// renderer listeners working while the tRPC `artifacts.onContentChanged` subscription
// consumes the same emitter (coexistence until the renderer cutover, slice 5).
//
// Module-load side-effect: registered once (ESM singleton). The fs.watch itself is
// only armed when `startArtifactWatcher` is called by the host.
artifactWatcherEvents.on('content-changed', (artifactId) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('artifacts:content-changed', artifactId)
    }
  }
})

export { artifactWatcherEvents, startArtifactWatcher, closeArtifactWatcher }
