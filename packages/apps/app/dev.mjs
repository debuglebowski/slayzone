// Dev launcher (plans/sidecar-staleness.md, Phase 3).
//
// `pnpm dev` used to be `pnpm --filter @slayzone/hub build && electron-vite
// dev` — a ONE-SHOT server build, so editing server code left the running
// sidecar stale until a full app restart. This launcher instead:
//   1. builds the sidecar (hub) and the local computer once, in parallel
//      (electron main spawns both from their dist/bin.cjs),
//   2. keeps a watcher per bundle rebuilding it whenever any bundled input
//      changes — the package's own src AND the workspace server code it inlines
//      (hub: bin.cjs + manifest stay fresh → the Diagnostics tab surfaces
//      staleness, and with SLAYZONE_SIDECAR_HOT_RESTART=1 the supervisor
//      hot-restarts onto it; computer: the next spawn runs fresh code),
//   3. runs electron-vite dev for the app itself.
//
// No concurrency dependency — a tiny process supervisor; see the process-group
// note below for how app and launcher always end together.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const appDir = dirname(fileURLToPath(import.meta.url))
const hubDir = join(appDir, '..', 'hub')
const computerDir = join(appDir, '..', 'computer')
const electronViteBin = join(
  dirname(createRequire(import.meta.url).resolve('electron-vite/package.json')),
  'bin',
  'electron-vite.js'
)

// Exit code main uses for "relaunch me" under electron-vite dev
// (DEV_RELAUNCH_EXIT_CODE in src/main/index.ts). `app.relaunch()` would start a
// detached Electron nobody supervises, while this launcher exited with the old
// one — so main exits with this code and we restart electron-vite instead.
const DEV_RELAUNCH_EXIT_CODE = 75
// Longer than main's QUIT_WATCHDOG_MS (15s): a draining quit gets to finish.
const SHUTDOWN_GRACE_MS = 20_000

// Teardown must reach the whole tree — electron-vite AND the Electron it
// spawns, which electron-vite never kills on its own exit. That makes this
// launcher the single owner: any way it is stopped (Ctrl-C, SIGTERM, terminal
// closed) tears down the app, and any way the app ends ends this launcher.
//   - POSIX: every child runs in its OWN process group (detached) and is
//     signalled as a group. stdin is ignored: a background process group
//     reading the tty would be stopped by SIGTTIN.
//   - Windows: no process groups (and detached = a new console window), so
//     children stay attached and the tree is walked by `taskkill /T` — first
//     without /F (WM_CLOSE → Electron quits gracefully), then forced. The tree
//     is resolved from the direct child, which electron-vite keeps alive until
//     Electron exits, so the direct child's liveness tracks the app's.
const isWindows = process.platform === 'win32'
const children = new Set()
let shuttingDown = false

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
    return true
  } catch {
    return false // group already gone
  }
}

function taskkillTree(child, force) {
  return new Promise((resolve) => {
    const args = ['/T', '/PID', String(child.pid)]
    if (force) args.unshift('/F')
    spawn('taskkill', args, { stdio: 'ignore' }).on('exit', resolve).on('error', resolve)
  })
}

function alive(child) {
  if (isWindows) return child.exitCode === null && child.signalCode === null
  return signalGroup(child, 0)
}

async function terminateTree(child, force) {
  if (isWindows) await taskkillTree(child, force)
  else signalGroup(child, force ? 'SIGKILL' : 'SIGTERM')
}

async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([...children].filter(alive).map((c) => terminateTree(c, false)))
  const deadline = Date.now() + SHUTDOWN_GRACE_MS
  while ([...children].some(alive) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  await Promise.all([...children].filter(alive).map((c) => terminateTree(c, true)))
  process.exit(code ?? 0)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void shutdown(0))

function run(cmd, args, opts) {
  const child = spawn(cmd, args, {
    stdio: isWindows ? 'inherit' : ['ignore', 'inherit', 'inherit'],
    detached: !isWindows,
    ...opts
  })
  children.add(child)
  return child
}

function exitCode(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)))
}

// 3. The Electron app (main/preload/renderer via electron-vite HMR). electron-vite
//    exits with Electron's exit code (any quit: Cmd+Q, last window closed, crash,
//    quit watchdog), which ends this launcher — except a dev relaunch request.
function startApp() {
  const app = run(process.execPath, [electronViteBin, 'dev'], { cwd: appDir })
  app.on('exit', (code) => {
    if (shuttingDown) return
    // POSIX: reap a still-alive Electron left in the group (electron-vite
    // itself crashed). Windows can't: with the root gone, taskkill has no tree
    // to walk — the one case there that can still orphan the app.
    if (!isWindows) signalGroup(app, 'SIGTERM')
    children.delete(app)
    if (code === DEV_RELAUNCH_EXIT_CODE) {
      console.log('[dev] app requested relaunch — restarting electron-vite')
      startApp()
      return
    }
    void shutdown(code ?? 0)
  })
}

// 1. Build the sidecar + computer once up front, in parallel — electron main
//    resolves + spawns both from dist/bin.cjs at boot, so they must exist
//    before electron-vite starts.
const [hubCode, computerCode] = await Promise.all([
  exitCode(run('node', ['build.mjs'], { cwd: hubDir })),
  exitCode(run('node', ['build.mjs'], { cwd: computerDir }))
])
if (hubCode !== 0) {
  console.error(`[dev] initial sidecar build failed (exit ${hubCode})`)
  void shutdown(hubCode ?? 1)
} else {
  if (computerCode !== 0) {
    // Not fatal: the app still boots on the hub; the local computer spawns
    // from whatever dist/bin.cjs exists, and the watcher below rebuilds it as
    // soon as the breaking edit is fixed.
    console.error(`[dev] initial computer build failed (exit ${computerCode}) — continuing`)
  }
  // 2. Watch every bundle input for rebuilds (--no-initial: we just built above).
  run('node', ['build.mjs', '--watch', '--no-initial'], { cwd: hubDir })
  run('node', ['build.mjs', '--watch', '--no-initial'], { cwd: computerDir })
  startApp()
}
