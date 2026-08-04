import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ensureRunnerBuilt } from './fixtures/runner-build'
import {
  parsePgrepOutput,
  readProcessEnviron,
  selectTestRunPids
} from './fixtures/stale-processes'

/**
 * Kill processes from a previous TEST run whose command line matches `pattern`.
 *
 * The pattern alone is not a sufficient filter: a test run and the developer's
 * live `pnpm dev` app run the same bundles from the same paths. Matching on the
 * path alone SIGTERM'd the supervised dev app's local runner — which owns every
 * agent pty — so every agent on the machine died on each `pnpm test:e2e`.
 * `selectTestRunPids` requires the Playwright environment marker before killing.
 */
function killStale(pattern: string, label: string): void {
  try {
    const out = execSync(`pgrep -af ${JSON.stringify(pattern)} || true`, {
      encoding: 'utf8',
      timeout: 5_000
    }).trim()
    if (!out) return
    const candidates = parsePgrepOutput(out)
    const pids = selectTestRunPids(candidates, readProcessEnviron, [process.pid, process.ppid])
    const spared = candidates.length - pids.length
    if (spared > 0) {
      // Say so: silently sparing a match is indistinguishable from a broken
      // pattern, and a broken pattern is exactly how the sidecar reaper below
      // rotted unnoticed.
      console.log(
        `[global-setup] Left ${spared} non-test ${label} process(es) alone (no PLAYWRIGHT marker)`
      )
    }
    for (const pid of pids) {
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
  // `bin.cjs`, not `bin.js`: the sidecar bundle was renamed and these patterns
  // were not, so for every release since they matched NOTHING and orphaned
  // sidecars accumulated unreaped (26 were found alive, days old, ~1.6 GB).
  // `bin\.c?js` covers both so a future rename back is still caught.
  killStale('hub/dist/bin\\.c?js', 'side-car')
  killStale('hub/bin\\.c?js', 'side-car')
  // Runners too. An orphan from an interrupted run keeps re-dialing whatever hub
  // port it can reach, so a FRESH worker's gate sees `connected: true` within ~14ms
  // from a runner that process never spawned — and that runner then dies mid-test
  // when its credentials or port stop matching. One was found alive 25+ HOURS later.
  // Harmless while the hub could execute work in-process; with runners as the only
  // exec path it silently poisons whichever worker it attaches to.
  //
  // This pattern also matches the SUPERVISED DEV APP's live runner — identical
  // bundle, identical path. Killing it took down every agent pty on the machine
  // once per test run; `killStale` now requires the Playwright env marker, which
  // only a test-run process carries.
  killStale('runner/dist/bin\\.cjs', 'runner')

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

  // e2e is runner-ON by default (every worker app auto-enrolls a co-located
  // runner), so the bundle must exist before the first launch — not just for the
  // runner specs. Idempotent + no-ops when already fresh.
  ensureRunnerBuilt()
}
