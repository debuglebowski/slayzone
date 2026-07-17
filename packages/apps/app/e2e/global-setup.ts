import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/** Kill processes whose full command line matches `pattern`. */
function killStale(pattern: string, label: string): void {
  try {
    const out = execSync(`pgrep -af ${JSON.stringify(pattern)} || true`, {
      encoding: 'utf8',
      timeout: 5_000
    }).trim()
    if (!out) return
    for (const line of out.split('\n')) {
      const pid = parseInt(line.trim(), 10)
      if (!pid || pid === process.pid || pid === process.ppid) continue
      try {
        process.kill(pid, 'SIGTERM')
        console.log(`[global-setup] Killed stale ${label} process ${pid}`)
      } catch {
        // Already dead or not ours
      }
    }
  } catch {
    // pgrep not available or other error — not fatal
  }
}

/**
 * Kill stale processes from previous interrupted test runs. Without this, a
 * Ctrl+C'd run leaves orphans visible alongside the freshly launched app.
 *
 * The side-car runs as the Electron binary (via ELECTRON_RUN_AS_NODE), so it
 * is matched by its bin.js script path in argv — not a binary name.
 */
export default function globalSetup(): void {
  killStale('Electron.*out/main/index\\.js', 'Electron')
  killStale('hub/dist/bin\\.js', 'side-car')
  killStale('hub/bin\\.js', 'side-car')

  // Under Playwright the app loads from out/main, so the sidecar's dev
  // scriptPath (`app.getAppPath()/../hub/dist/bin.cjs`) resolves to
  // out/hub/... — the root build doesn't create that link. Idempotent.
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const linkPath = path.join(appDir, 'out', 'hub')
  if (!fs.existsSync(linkPath)) {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    fs.symlinkSync(path.join('..', '..', 'hub'), linkPath)
    console.log('[global-setup] Created out/hub symlink for the side-car')
  }

  // Same shape for the local runner (hub/runner split): its dev scriptPath
  // (`app.getAppPath()/../runner/dist/bin.cjs`) resolves to out/runner/... under
  // Playwright, so the runner-loopback auto-enroll spec can find the bundle the
  // runner build produced at packages/apps/runner/dist. Idempotent.
  const runnerLinkPath = path.join(appDir, 'out', 'runner')
  if (!fs.existsSync(runnerLinkPath)) {
    fs.mkdirSync(path.dirname(runnerLinkPath), { recursive: true })
    fs.symlinkSync(path.join('..', '..', 'runner'), runnerLinkPath)
    console.log('[global-setup] Created out/runner symlink for the local runner')
  }
}
