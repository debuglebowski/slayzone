// Dev launcher (plans/sidecar-staleness.md, Phase 3).
//
// `pnpm dev` used to be `pnpm --filter @slayzone/server build && electron-vite
// dev` — a ONE-SHOT server build, so editing server code left the running
// sidecar stale until a full app restart. This launcher instead:
//   1. builds the sidecar once (electron main spawns it from dist/bin.cjs),
//   2. keeps a watcher rebuilding it on every server-src change (bin.cjs +
//      manifest stay fresh → the Diagnostics tab surfaces staleness, and with
//      SLAYZONE_SIDECAR_HOT_RESTART=1 the supervisor hot-restarts onto it),
//   3. runs electron-vite dev for the app itself.
//
// No concurrency dependency — a tiny process supervisor. Killing this process
// (Ctrl-C) tears down both children.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const appDir = dirname(fileURLToPath(import.meta.url))
const serverDir = join(appDir, '..', 'server')

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

// 1. Build the sidecar once up front — electron main resolves + spawns it from
//    dist/bin.cjs at boot, so it must exist before electron-vite starts.
const initial = run('node', ['build.mjs'], { cwd: serverDir })
initial.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[dev] initial sidecar build failed (exit ${code})`)
    shutdown(code ?? 1)
    return
  }
  // 2. Watch server src for rebuilds (--no-initial: we just built above).
  run('node', ['build.mjs', '--watch', '--no-initial'], { cwd: serverDir })
  // 3. The Electron app (main/preload/renderer via electron-vite HMR). pnpm exec
  //    resolves the electron-vite bin from node_modules (PATH isn't seeded here
  //    the way it is inside an npm script).
  const app = run('pnpm', ['exec', 'electron-vite', 'dev'], { cwd: appDir })
  app.on('exit', (code) => shutdown(code ?? 0))
})
