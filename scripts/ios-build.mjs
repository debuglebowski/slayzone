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
 *   1. locked + utility: `expo run:ios --no-bundler --output <tmp>` (prebuild, pod install,
 *      xcodebuild, install). On a simulator it also opens the app, which shows "no dev
 *      server" for the moment until step 2 relaunches it.
 *   2. unlocked: `expo run:ios --binary <tmp>/<App>.app` with the caller's args: installs the
 *      built app (no xcodebuild), starts Metro, opens the app on it, stays interactive.
 * With `--no-bundler` or `--device generic` there is no step 2 (no dev server wanted); with
 * `--binary`, `--unstable-rebundle` or `--help` there is no build, so nothing is locked.
 * A bare `-d` (pick a device) asks in both steps.
 *
 * `exec` runs any other build command locked + utility (xcodebuild archive, pod install).
 * Lock skipped when CI is set or SLZ_NO_CI_LOCK=1, as for every ci-lock user.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
 * The `expo` argv of each phase of `run`. `build`: locked, `serve`: unlocked after it; either
 * may be null. `outputDir` is where the build copies the app when the caller gave no --output.
 */
export function planRun(args, outputDir) {
  const noBuild =
    args.includes('--help') ||
    args.includes('-h') ||
    args.includes('--unstable-rebundle') || // re-bundles the installed app, no xcodebuild
    optionValue(args, ['--binary']) !== undefined
  if (noBuild) {
    return { build: null, serve: ['run:ios', ...args], outputDir: null }
  }
  const device = optionValue(args, ['--device', '-d'])
  if (args.includes('--no-bundler') || device === 'generic') {
    return { build: ['run:ios', ...args], serve: null, outputDir: null }
  }
  const userOutput = optionValue(args, ['--output', '-o'])
  const out = typeof userOutput === 'string' ? userOutput : outputDir
  // --port only names the dev server (and expo refuses it with --no-bundler).
  const buildArgs = withoutOption(args, ['--port', '-p'], true)
  const build = ['run:ios', ...buildArgs, '--no-bundler']
  if (typeof userOutput !== 'string') build.push('--output', out)
  // Step 2 builds nothing (--binary): every other option keeps its meaning there.
  const serveArgs = withoutOption(args, ['--output', '-o'], true)
  return { build, serve: ['run:ios', ...serveArgs], outputDir: out }
}

/** The newest `*.app` in `dir` (the build copies exactly one into a fresh dir). */
export function builtApp(dir) {
  const apps = readdirSync(dir)
    .filter((n) => n.endsWith('.app'))
    .map((n) => join(dir, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return apps[0] ?? null
}

/** `expo` CLI as the mobile app resolves it (hoisted: no `.bin/expo` in the app's dir). */
function expoCommand() {
  const pkg = createRequire(join(MOBILE_DIR, 'package.json')).resolve('expo/package.json')
  return [process.execPath, join(dirname(pkg), 'bin', 'cli')]
}

/** Runs `cmd` unlocked in the foreground; Ctrl-C goes to it, this waits for its exit. */
function runForeground(cmd, { cwd }) {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', cwd })
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const onSignal = (sig) => {
    if (sig !== 'SIGINT') child.kill(sig)
  }
  for (const sig of signals) process.on(sig, onSignal)
  return new Promise((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(`ios-build: cannot run ${cmd[0]}: ${err.message}\n`)
      resolve({ code: 127, signal: null })
    })
    child.on('exit', (code, signal) => {
      for (const sig of signals) process.off(sig, onSignal)
      resolve({ code, signal })
    })
  })
}

function lockedBuild(cmd, cwd) {
  return runCommandLocked({ label: 'ios-build', cmd: atUtilityQos(cmd), cwd })
}

async function main(argv) {
  const [mode, ...rest] = argv
  if (mode === 'exec') {
    const cmd = rest[0] === '--' ? rest.slice(1) : rest
    if (cmd.length === 0) usage()
    return exitLike(await lockedBuild(cmd, process.cwd()))
  }
  if (mode !== 'run') usage()

  const tmp = mkdtempSync(join(tmpdir(), 'slz-ios-build-'))
  const cleanup = () => rmSync(tmp, { recursive: true, force: true })
  process.on('exit', cleanup) // backstop; a signal exit skips it, so finish() cleans first
  const finish = (r) => {
    cleanup()
    exitLike(r)
  }
  const plan = planRun(rest, tmp)
  const expo = expoCommand()
  if (plan.build) {
    const r = await lockedBuild([...expo, ...plan.build], MOBILE_DIR)
    if (r.signal || r.code !== 0 || !plan.serve) return finish(r)
  }
  const serve = [...expo, ...plan.serve]
  if (plan.outputDir) {
    const app = builtApp(resolve(MOBILE_DIR, plan.outputDir)) // expo ran in MOBILE_DIR
    if (!app) {
      process.stderr.write(`ios-build: the build left no .app in ${plan.outputDir}\n`)
      return finish({ code: 1, signal: null })
    }
    serve.push('--binary', app)
  }
  finish(await runForeground(serve, { cwd: MOBILE_DIR }))
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
