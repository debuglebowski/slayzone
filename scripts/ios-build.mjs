#!/usr/bin/env node
/**
 * Local iOS builds of the mobile app, inside the machine-wide CI lock (scripts/ci-lock.mjs,
 * shared with madacademy ci/lock.sh) and at macOS utility QoS (`taskpolicy -c utility`, the
 * madacademy gate's default: yields to interactive work without starving like `-b`).
 * An Xcode build next to a test gate loads the box as much as a second gate does.
 *
 *   node scripts/ios-build.mjs run [expo run:ios args]   pnpm --filter @slayzone/mobile ios
 *   node scripts/ios-build.mjs exec -- <cmd> [args]      pnpm --filter @slayzone/mobile ios:exec <cmd>
 *
 * `run` is `expo run:ios` with only the build inside the lock — a dev session keeps Metro
 * running for hours and must not hold the queue:
 *   1. unlocked: this app's Metro (`expo start --dev-client`) on a free port (8081 first, or
 *      `--port`), in the foreground: its keys work, it outlives the build.
 *   2. locked + utility, once Metro answers: `expo run:ios --port <that port>` (prebuild,
 *      pod install, xcodebuild, install, open). expo sees this app's Metro on the port, so it
 *      starts none and opens the app on it — never on another checkout's Metro.
 * Step 2 reads no keys (Metro has them): name the device (`-d <name|udid>`), a bare `-d`
 * cannot ask. With `--no-bundler` or `--device generic` only step 2 runs (no dev server
 * wanted); with `--binary`, `--unstable-rebundle` or `--help` nothing builds, so expo runs
 * as is, unlocked.
 *
 * `exec` runs any other build command locked + utility (xcodebuild archive, pod install).
 * Lock skipped when CI is set or SLZ_NO_CI_LOCK=1, as for every ci-lock user.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exitLike, runCommandLocked } from './ci-lock.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
export const MOBILE_DIR = join(REPO, 'packages', 'apps', 'mobile')
const TASKPOLICY = '/usr/sbin/taskpolicy'

/** `cmd` at utility QoS on macOS (clamp inherited by every child: xcodebuild, clang). */
export function atUtilityQos(cmd, { platform = process.platform, has = existsSync } = {}) {
  return platform === 'darwin' && has(TASKPOLICY) ? [TASKPOLICY, '-c', 'utility', ...cmd] : cmd
}

/** Value of `--flag v` / `--flag=v` / `-f v` in `args`, else undefined (true when bare). */
function optionValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) {
        const next = args[i + 1]
        return next === undefined || next.startsWith('-') ? true : next
      }
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
    }
  }
  return undefined
}

/** `args` without option `names` and their values (when `takesValue`). */
function withoutOption(args, names, takesValue) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (names.includes(a)) {
      if (takesValue && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++
      continue
    }
    if (names.some((n) => a.startsWith(`${n}=`))) continue
    out.push(a)
  }
  return out
}

/**
 * What `run` starts, as `expo` argv: `direct` (expo as is, nothing built: unlocked), or
 * `build` (locked) with `metro` (this app's dev server, started first; null when none is
 * wanted). `port` is the free Metro port found by the caller; the caller's `--port` wins.
 */
export function planRun(args, port) {
  const noBuild =
    args.includes('--help') ||
    args.includes('-h') ||
    args.includes('--unstable-rebundle') || // re-bundles the installed app, no xcodebuild
    optionValue(args, ['--binary']) !== undefined
  if (noBuild) return { direct: ['run:ios', ...args], build: null, metro: null }
  const device = optionValue(args, ['--device', '-d'])
  if (args.includes('--no-bundler') || device === 'generic') {
    return { direct: null, build: ['run:ios', ...args], metro: null }
  }
  const p = String(explicitPort(args) ?? port)
  return {
    direct: null,
    build: ['run:ios', ...withoutOption(args, ['--port', '-p'], true), '--port', p],
    metro: ['start', '--dev-client', '--port', p]
  }
}

/** The caller's `--port` / `-p`, else null. */
export function explicitPort(args) {
  const v = optionValue(args, ['--port', '-p'])
  return typeof v === 'string' ? Number(v) : null
}

/** Env of the build: the app compiled against this Metro's port. */
export function buildEnv(env, port) {
  return { ...env, RCT_METRO_PORT: String(port) }
}

/** True when nothing listens on `port` (expo's own test: bind on all interfaces). */
function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, () => server.close(() => resolve(true)))
  })
}

/** The first free port from `start` up (expo would ask; step 2 cannot). */
export async function firstFreePort(start, isFree = portFree) {
  for (let port = start; port < start + 100; port++) if (await isFree(port)) return port
  throw new Error(`ios-build: no free port in ${start}-${start + 99}`)
}

/** `expo` CLI as the mobile app resolves it (hoisted: no `.bin/expo` in the app's dir). */
function expoCommand() {
  const pkg = createRequire(join(MOBILE_DIR, 'package.json')).resolve('expo/package.json')
  return [process.execPath, join(dirname(pkg), 'bin', 'cli')]
}

/** Spawns `cmd` in the foreground; `done` resolves `{ code, signal }` when it exits. */
function start(cmd, { cwd }) {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', cwd })
  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(`ios-build: cannot run ${cmd[0]}: ${err.message}\n`)
      resolve({ code: 127, signal: null })
    })
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  return { child, done }
}

/** Resolves true once Metro on `port` answers /status, false if `exited` comes first. */
async function metroReady(port, exited) {
  let gone = false
  exited.then(() => {
    gone = true
  })
  while (!gone) {
    const ok = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.text())
      .then((t) => t.includes('packager-status:running'))
      .catch(() => false)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

function lockedBuild(cmd, cwd, { stdin = 'inherit', env = process.env } = {}) {
  return runCommandLocked({ label: 'ios-build', cmd: atUtilityQos(cmd), cwd, stdin, env })
}

async function main(argv) {
  const [mode, ...rest] = argv
  if (mode === 'exec') {
    const cmd = rest[0] === '--' ? rest.slice(1) : rest
    if (cmd.length === 0) usage()
    return exitLike(await lockedBuild(cmd, process.cwd()))
  }
  if (mode !== 'run') usage()

  const expo = expoCommand()
  const port =
    explicitPort(rest) ?? (await firstFreePort(Number(process.env.RCT_METRO_PORT) || 8081))
  const plan = planRun(rest, port)
  if (plan.direct) return exitLike(await start([...expo, ...plan.direct], { cwd: MOBILE_DIR }).done)
  if (!plan.metro) return exitLike(await lockedBuild([...expo, ...plan.build], MOBILE_DIR))

  const metro = start([...expo, ...plan.metro], { cwd: MOBILE_DIR })
  process.on('exit', () => metro.child.kill()) // backstop: never leave Metro behind
  // Ctrl-C reaches Metro (same process group): wait for it. SIGTERM / SIGHUP: pass on.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => sig !== 'SIGINT' && metro.child.kill(sig))
  }
  if (!(await metroReady(port, metro.done))) return exitLike(await metro.done)
  // Metro owns the terminal's keys; the build reads none.
  // The app's Metro port is compiled in from RCT_METRO_PORT (React-Core); expo sets it only
  // for a Metro it starts itself, so without it the app would load whatever runs on 8081.
  const built = await lockedBuild([...expo, ...plan.build], MOBILE_DIR, {
    stdin: 'ignore',
    env: buildEnv(process.env, port)
  })
  if (built.signal || built.code !== 0) {
    metro.child.kill('SIGTERM')
    await metro.done
    return exitLike(built)
  }
  exitLike(await metro.done)
}

function usage() {
  process.stderr.write(
    'usage: node scripts/ios-build.mjs run [expo run:ios args]\n' +
      '       node scripts/ios-build.mjs exec -- <command> [args...]\n'
  )
  process.exit(2)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2))
}
