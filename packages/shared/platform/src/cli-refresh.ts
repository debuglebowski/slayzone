import fs from 'fs'
import path from 'path'
import { WINDOWS_SHIM, getCliBinDir, windowsCliJsSource } from './cli-install'

export interface CliRefreshResult {
  status: 'noop' | 'refreshed' | 'failed'
  error?: string
}

/**
 * Keep the Windows `slay` copy current across app upgrades.
 *
 * macOS/Linux install a symlink into the app bundle, so `slay` is always the running
 * app's CLI. Windows COPIES `slay.js` next to a `slay.cmd` shim and, before this, never
 * touched it again. v0.35.0's `slay.js` opens `<userData>/slayzone.sqlite` directly; the
 * upgraded app keeps its data in the hub root under a new name and leaves that file
 * behind (migrations are copy-only), so a stale `slay` kept writing tasks, progress and
 * artifacts into a database the app never reads again. The current CLI talks to the hub
 * over REST and opens no database.
 *
 * Only refreshes an install that already exists (the user chose to install the CLI) and
 * never edits PATH. A copy that is already current is left untouched. Failure (for
 * example `slay.js` held open by a running `slay`) is reported, not thrown, and the old
 * copy stays: the next launch retries.
 */
export function refreshWindowsCliIn(srcJs: string, binDir: string): CliRefreshResult {
  const destJs = path.join(binDir, 'slay.js')
  const shim = path.join(binDir, 'slay.cmd')
  if (!fs.existsSync(shim) || !fs.existsSync(srcJs)) return { status: 'noop' }

  const tmpJs = `${destJs}.updating`
  try {
    const bundled = fs.readFileSync(srcJs)
    const jsCurrent = fs.existsSync(destJs) && fs.readFileSync(destJs).equals(bundled)
    const shimCurrent = fs.readFileSync(shim, 'utf8') === WINDOWS_SHIM
    if (jsCurrent && shimCurrent) return { status: 'noop' }

    // Temp + rename: a crash mid-write must not leave a truncated CLI under its name.
    fs.writeFileSync(tmpJs, bundled)
    fs.renameSync(tmpJs, destJs)
    fs.writeFileSync(shim, WINDOWS_SHIM)
    return { status: 'refreshed' }
  } catch (err) {
    fs.rmSync(tmpJs, { force: true })
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Launch-time entry point. Windows only; everywhere else `slay` is already a symlink. */
export function refreshInstalledCliSync(cliSrcPath: string): CliRefreshResult {
  if (process.platform !== 'win32') return { status: 'noop' }
  return refreshWindowsCliIn(windowsCliJsSource(cliSrcPath), getCliBinDir())
}
