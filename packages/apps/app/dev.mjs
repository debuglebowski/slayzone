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
// No concurrency dependency — a tiny process supervisor. Killing this process
// (Ctrl-C) tears down both children.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const appDir = dirname(fileURLToPath(import.meta.url))
const hubDir = join(appDir, '..', 'hub')
const computerDir = join(appDir, '..', 'computer')

const children = []
let shuttingDown = false
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  process.exit(code ?? 0)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function run(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
  children.push(child)
  return child
}

function exitCode(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)))
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
  shutdown(hubCode ?? 1)
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
  // 3. The Electron app (main/preload/renderer via electron-vite HMR). pnpm exec
  //    resolves the electron-vite bin from node_modules (PATH isn't seeded here
  //    the way it is inside an npm script).
  const app = run('pnpm', ['exec', 'electron-vite', 'dev'], { cwd: appDir })
  app.on('exit', (code) => shutdown(code ?? 0))
}
