import { app, BrowserWindow, ipcMain, autoUpdater as nativeAutoUpdater } from 'electron'
import { is } from '@electron-toolkit/utils'
// electron-updater is CJS. electron-vite v5 outputs ESM for main, and Node's
// CJS→ESM interop doesn't detect Object.defineProperty getters as named exports.
// A default import gives us the raw CJS exports object where the getter works.
import electronUpdater from 'electron-updater'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/electron'

const RENDERER_DRAIN_TIMEOUT_MS = 5_000
let isRestarting = false

let autoUpdater: typeof electronUpdater.autoUpdater | null = null
let downloadedVersion: string | null = null
// On macOS, MacUpdater proxies the download to native Squirrel for staging.
// This tracks when Squirrel has finished staging (separate from electron-updater's download).
// quitAndInstall() works immediately when true; if false, MacUpdater waits for Squirrel.
let nativeSquirrelReady = false

function getAutoUpdater() {
  if (!autoUpdater) {
    autoUpdater = electronUpdater.autoUpdater
    autoUpdater.autoInstallOnAppQuit = true
    // Propagate errors to renderer so the user sees them, not just the console
    autoUpdater.on('error', (err) => {
      console.error('[updater] error:', err.message)
      sendUpdateStatus({ type: 'error', message: err.message })
    })
    autoUpdater.on('update-available', (info) => console.log('[updater] update available:', info.version))
    autoUpdater.on('download-progress', (p) => {
      BrowserWindow.getAllWindows()[0]?.setProgressBar(p.percent / 100)
      sendUpdateStatus({ type: 'downloading', percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      console.log('[updater] downloaded:', info.version)
      downloadedVersion = info.version
      const win = BrowserWindow.getAllWindows()[0]
      win?.setProgressBar(-1)
      win?.webContents.send('app:update-status', { type: 'downloaded', version: info.version })
    })

    // On macOS, MacUpdater uses native Squirrel to stage the update after electron-updater
    // finishes downloading. Track native Squirrel readiness independently — MacUpdater.quitAndInstall()
    // only calls app.quit() immediately if squirrelDownloadedUpdate is true, otherwise it registers
    // a listener and waits. Errors from Squirrel propagate via MacUpdater.emit('error') above.
    if (process.platform === 'darwin') {
      nativeAutoUpdater.on('update-downloaded', () => {
        nativeSquirrelReady = true
        console.log('[updater] squirrel: staged and ready to install')
      })
    }
  }
  return autoUpdater
}

const CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export function initAutoUpdater(): void {
  if (is.dev) return
  try {
    getAutoUpdater().checkForUpdatesAndNotify()
  } catch (err) {
    console.error('[updater] init failed:', err instanceof Error ? err.message : err)
  }
  setInterval(() => {
    if (downloadedVersion) return
    console.log('[updater] periodic check')
    getAutoUpdater().checkForUpdatesAndNotify().catch((err) => {
      console.error('[updater] periodic check failed:', err instanceof Error ? err.message : err)
    })
  }, CHECK_INTERVAL_MS)
}

async function waitForRendererDrain(): Promise<'ready' | 'timeout' | 'no-window'> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return 'no-window'
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('app:update-drain-ready', onReady)
      resolve('timeout')
    }, RENDERER_DRAIN_TIMEOUT_MS)
    const onReady = (): void => {
      clearTimeout(timer)
      resolve('ready')
    }
    ipcMain.once('app:update-drain-ready', onReady)
    try {
      win.webContents.send('app:update-drain-request')
    } catch {
      clearTimeout(timer)
      ipcMain.removeListener('app:update-drain-ready', onReady)
      resolve('no-window')
    }
  })
}

export async function restartForUpdate(): Promise<void> {
  if (isRestarting) return
  isRestarting = true
  try {
    if (!autoUpdater) {
      console.error('[updater] restartForUpdate: autoUpdater not initialized')
      sendUpdateStatus({ type: 'error', message: 'Updater not initialized' })
      return
    }

    recordDiagnosticEvent({
      level: 'info', source: 'main', event: 'app.update.installing',
      payload: {
        from: app.getVersion(),
        to: downloadedVersion,
        squirrelReady: nativeSquirrelReady,
        platform: process.platform
      }
    })

    if (process.platform === 'darwin') {
      console.log(`[updater] restartForUpdate: squirrelReady=${nativeSquirrelReady}`)
      // If Squirrel hasn't staged yet, MacUpdater.quitAndInstall() will register a listener
      // and quit once staging completes. This is expected — no action needed here.
    }

    const drainResult = await waitForRendererDrain()
    recordDiagnosticEvent({
      level: 'info', source: 'main', event: 'app.update.drain',
      payload: { result: drainResult }
    })

    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    console.error('[updater] quitAndInstall failed:', err)
    sendUpdateStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    // If quitAndInstall succeeded, process exits and this never matters.
    // If it threw, allow user to retry.
    isRestarting = false
  }
}

function sendUpdateStatus(status: import('@slayzone/types').UpdateStatus): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('app:update-status', status)
}

export async function checkForUpdates(): Promise<void> {
  sendUpdateStatus({ type: 'checking' })

  if (is.dev) {
    sendUpdateStatus({ type: 'not-available' })
    return
  }

  try {
    const updater = getAutoUpdater()

    // If already downloaded, just re-notify renderer
    if (downloadedVersion) {
      sendUpdateStatus({ type: 'downloaded', version: downloadedVersion })
      return
    }

    const result = await updater.checkForUpdates()
    if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
      sendUpdateStatus({ type: 'not-available' })
      return
    }

    // Download in progress — the 'update-downloaded' handler will notify renderer
  } catch (err) {
    sendUpdateStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
