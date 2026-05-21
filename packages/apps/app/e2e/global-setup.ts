import { execSync } from 'child_process'

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
  killStale('server/dist/bin\\.js', 'side-car')
  killStale('server/bin\\.js', 'side-car')
}
