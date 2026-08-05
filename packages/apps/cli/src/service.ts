/**
 * Supervisor plumbing shared by `slay hub` and `slay runner`.
 *
 * `@slayzone/platform/service-unit` renders and installs the unit FILE; this module
 * owns everything around it that needs a child process or the local filesystem:
 *   - talking to `launchctl` / `systemctl` / `loginctl` (start, stop, status),
 *   - resolving which BUNDLE the unit should point at (including installing the npm
 *     package on demand) and which INTERPRETER can actually run it,
 *   - reading a service's logs back.
 *
 * Split from the file rendering on purpose: keeping the `execFileSync` calls out of
 * the platform package is what lets `service-unit.test.ts` assert unit CONTENT
 * without registering anything on the machine running the suite.
 *
 * Both kinds go through the same functions with a `ServiceKind` argument, so a fix to
 * (say) the launchd double-start bug can only ever be fixed once.
 *
 * @module cli/service
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  detectBackend,
  launchdLabel,
  serviceLogNames,
  systemdUnitName,
  type ServiceBackend,
  type ServiceKind
} from '@slayzone/platform/service-unit'
import { getServiceRuntimeDir } from './cli-state'

/** This CLI's version, substituted by build.mjs. The hub and runner are released
 *  from the same repo at the same version, so it is what we install (see
 *  {@link resolveServiceBin}). */
declare const __APP_VERSION__: string
const CLI_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

/** Print and exit non-zero. Every command's failure path funnels through here. */
export function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/** Collapse `$HOME` to `~` so path columns stay readable. */
export function shortenPath(path: string): string {
  const home = process.env.HOME ?? ''
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/**
 * Which service backend to use. `SLZ_FORCE_NO_SERVICE` is a test-only escape hatch
 * that forces the unsupervised path, so a test can exercise create/boot-failure
 * WITHOUT installing a launchd/systemd unit on the machine running it.
 */
export function resolveBackend(): ServiceBackend {
  return process.env.SLZ_FORCE_NO_SERVICE === '1' ? 'none' : detectBackend()
}

// ---------------------------------------------------------------- bundle resolution

/** npm package + dev-tree location for each kind. */
const PACKAGES = {
  hub: { pkg: '@slayzone/hub', bin: 'slayzone-hub', devDir: 'hub', envOverride: 'SLZ_HUB_BIN' },
  runner: {
    pkg: '@slayzone/runner',
    bin: 'slayzone-runner',
    devDir: 'runner',
    envOverride: 'SLZ_RUNNER_BIN'
  }
} as const satisfies Record<ServiceKind, unknown>

/** The npm package name providing a kind's binary — quoted in operator messages. */
export function servicePackage(kind: ServiceKind): string {
  return PACKAGES[kind].pkg
}

/** How to invoke a resolved hub/runner bundle. */
export interface ServiceBin {
  command: string
  args: string[]
  version: string
  /** Extra env the interpreter needs (Electron-ABI dev tree). */
  env?: Record<string, string>
}

/** Read `{version, bin}` out of a package.json, or null when it isn't usable. */
function readServicePkg(
  kind: ServiceKind,
  pkgJsonPath: string
): { binPath: string; version: string } | null {
  let pkg: { version?: string; bin?: Record<string, string> | string }
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as typeof pkg
  } catch {
    return null
  }
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[PACKAGES[kind].bin]
  if (!binRel) return null
  const binPath = join(dirname(pkgJsonPath), binRel)
  if (!existsSync(binPath)) return null
  return { binPath, version: pkg.version ?? 'unknown' }
}

/**
 * Pick the interpreter a given bundle can actually run under.
 *
 * A monorepo checkout's native addons are compiled for ELECTRON's ABI
 * (NODE_MODULE_VERSION 145 vs plain node's 137) — `better-sqlite3` for the hub,
 * `node-pty` for the runner — so a dev-tree bundle launched with `node` dies
 * instantly on `require()`, and under a supervisor that means an invisible
 * crash-loop. Such a bundle must run as `ELECTRON_RUN_AS_NODE=1 <electron>`, which is
 * exactly how the desktop app spawns its own sidecar and local runner.
 *
 * An npm-INSTALLED bundle rebuilds its natives for the consumer's node at install
 * time, so it runs under plain node. Detection is by locating an electron binary in
 * the same tree as the bundle: present ⇒ dev checkout, absent ⇒ installed package.
 */
export function interpreterFor(binPath: string, version: string): ServiceBin {
  // Walk up from the bundle looking for a sibling electron install. A published
  // package has no electron anywhere above it.
  let dir = dirname(binPath)
  for (let i = 0; i < 6; i++) {
    const pathTxt = join(dir, 'node_modules', 'electron', 'path.txt')
    if (existsSync(pathTxt)) {
      try {
        const rel = readFileSync(pathTxt, 'utf8').trim()
        const electron = join(dir, 'node_modules', 'electron', 'dist', rel)
        if (existsSync(electron)) {
          return {
            command: electron,
            args: [binPath],
            version,
            // Runs Electron as a plain node with its own ABI — the natives match.
            env: { ELECTRON_RUN_AS_NODE: '1' }
          }
        }
      } catch {
        /* fall through to plain node */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Published package: natives were rebuilt for this node at install time.
  return { command: process.execPath, args: [binPath], version }
}

/**
 * Absolute path to a kind's bin — installing its npm package on demand if needed.
 *
 * The unit file must name a CONCRETE path: the supervisor re-executes this command
 * on every crash and every login, so an `npx` in there would mean a registry
 * round-trip (and possible silent version drift) per restart.
 *
 * Resolution order, each step deterministic:
 *   1. Node's own resolver (a global install, or a workspace checkout that lists
 *      the package as a dependency).
 *   2. The dev tree — a sibling `packages/apps/<kind>/dist/bin.cjs` next to this
 *      CLI. The monorepo CLI does NOT depend on the hub or runner package, so step 1
 *      misses them, yet this is the build a developer means.
 *   3. `npm install` into a private prefix under the CLI's own state dir, then
 *      resolve inside it. NOT `npx --package … node -p require.resolve(…)`: npx
 *      exposes the package's BIN on PATH but does not add its cache to Node's
 *      module resolution paths, so that require.resolve fails even though the
 *      download succeeded.
 */
export function resolveServiceBin(kind: ServiceKind): ServiceBin {
  const { pkg, devDir, envOverride } = PACKAGES[kind]

  // Test-only override: point `create` at a specific bundle so the failed-boot
  // rollback path can be exercised without a real hub/runner. Never set in normal use.
  const override = process.env[envOverride]
  if (override) return { command: process.execPath, args: [override], version: 'override' }

  const candidates: Array<() => string | null> = [
    // (1) Anchored on argv[1] (the slay script) — `import.meta` does not exist in
    // this package's CJS bundle.
    () => {
      try {
        return createRequire(process.argv[1] ?? join(process.cwd(), 'x')).resolve(
          `${pkg}/package.json`
        )
      } catch {
        return null
      }
    },
    // (2) Dev tree: <cli>/dist/slay.js → ../../<kind>/package.json
    () => {
      const self = process.argv[1]
      if (!self) return null
      const sibling = join(dirname(self), '..', '..', devDir, 'package.json')
      return existsSync(sibling) ? sibling : null
    }
  ]

  for (const find of candidates) {
    const path = find()
    if (!path) continue
    const found = readServicePkg(kind, path)
    if (found) return interpreterFor(found.binPath, found.version)
  }

  // (3) Install into our own prefix so the result is resolvable by absolute path
  // — and stays put, since the unit file will reference it for every restart.
  //
  // PIN THE VERSION TO THIS CLI'S OWN. A bare `npm install @slayzone/hub` follows
  // the `latest` dist-tag, which for a pre-release line lags behind (npm refuses
  // `latest` for a prerelease, so beta versions are published under `beta` and
  // `latest` keeps pointing at whatever stable/older version was tagged last).
  // That silently paired a current CLI with a much older hub. They are released
  // from one repo at one version, so requesting that exact version is both correct
  // and reproducible.
  const prefix = getServiceRuntimeDir(kind)
  const installed = join(prefix, 'node_modules', pkg, 'package.json')
  // Fall back to the `beta` tag rather than a bare name if the version define is
  // somehow missing: `latest` is the one thing that must never be followed here.
  const wanted = CLI_VERSION ? `${pkg}@${CLI_VERSION}` : `${pkg}@beta`
  if (
    !existsSync(installed) ||
    (CLI_VERSION && readServicePkg(kind, installed)?.version !== CLI_VERSION)
  ) {
    console.log(`Installing ${wanted}…`)
    mkdirSync(prefix, { recursive: true })
    try {
      execFileSync(
        'npm',
        ['install', '--prefix', prefix, '--no-save', '--no-fund', '--no-audit', wanted],
        { stdio: ['ignore', 'ignore', 'inherit'] }
      )
    } catch {
      fail(
        `Could not install ${wanted} into ${prefix}. Install it yourself and retry:\n` +
          `  npm install -g ${wanted}`
      )
    }
  }
  const found = readServicePkg(kind, installed)
  if (!found) {
    fail(
      `Installed ${pkg} but found no usable bin at ${installed}. ` +
        `Install it globally and retry:\n  npm install -g ${pkg}`
    )
  }
  // Invoke through an explicit interpreter rather than the bin's shebang: the
  // supervisor starts the unit with almost no PATH to find one on.
  return interpreterFor(found.binPath, found.version)
}

// ------------------------------------------------------------------ log directories

/**
 * The directory a kind's logs live in, created so the supervisor can open its files.
 *
 * Both kinds are flat now — a hub root holds `hub.config.json`/`hub.state.json`,
 * `cli-hub-target.json`, the DB, and `logs/` directly (no `storage/` wrapper); a
 * runner root holds `runner.config.json`/`runner.state.json` and `logs/`. So
 * both resolve to `<ROOT>/logs` — no per-kind branch needed anymore.
 */
export function ensureLogDir(kind: ServiceKind, root: string): string {
  const dir = logDirFor(kind, root)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** {@link ensureLogDir} without the side effect, for read paths. `kind` kept in the
 *  signature for API symmetry with the other per-kind helpers here, even though
 *  both kinds now resolve to the same shape. */
export function logDirFor(_kind: ServiceKind, root: string): string {
  return join(root, 'logs')
}

/** Absolute path of the supervisor's stdout / stderr capture for a service. */
export function serviceLogPaths(kind: ServiceKind, root: string): { out: string; err: string } {
  const dir = logDirFor(kind, root)
  const names = serviceLogNames(kind)
  return { out: join(dir, names.out), err: join(dir, names.err) }
}

/**
 * Fail, quoting the tail of the service's own output. Pointing at a log file and
 * making the operator go read it is a worse experience than just showing the reason.
 */
export function failWithLog(
  kind: ServiceKind,
  name: string,
  logPath: string,
  what: string
): never {
  let detail = ''
  try {
    detail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-12).join('\n')
  } catch {
    /* nothing captured */
  }
  const label = kind === 'hub' ? 'Hub' : 'Runner'
  fail(
    `${label} "${name}" ${what}.\n` +
      (detail
        ? `\nLast output (${shortenPath(logPath)}):\n${detail}\n`
        : `\nNo output was captured in ${shortenPath(logPath)}.\n`)
  )
}

/**
 * Read the last `lines` lines a service produced, or '' when nothing is readable.
 *
 * Used to WAIT for a boot signal (the runner has no `/health`, so its stdout is the
 * only evidence it enrolled) and to report a failure. Reads whichever of the
 * supervisor's two capture files is newest, since which one carries the interesting
 * output depends on how the process was started.
 */
export function readServiceLogTail(kind: ServiceKind, root: string, lines: number): string {
  const dir = logDirFor(kind, root)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.log'))
  } catch {
    return ''
  }
  const chunks: string[] = []
  for (const f of files) {
    try {
      chunks.push(readFileSync(join(dir, f), 'utf8'))
    } catch {
      /* unreadable — skip */
    }
  }
  return chunks.join('\n').trim().split('\n').slice(-lines).join('\n')
}

/**
 * Stream a service's logs to this terminal, replacing the current process's exit
 * code with the tail/journalctl child's.
 *
 * systemd captures stdout into journald rather than a file, so a registered systemd
 * unit's own output is only readable there; every other case reads the newest `.log`
 * in the service's log dir.
 */
export function followServiceLog(args: {
  kind: ServiceKind
  name: string
  root: string
  lines: number
  follow: boolean
  /** True when a systemd unit exists for this service (⇒ journalctl). */
  systemdUnit: boolean
}): void {
  const { kind, name, root, lines, follow, systemdUnit } = args
  if (systemdUnit) {
    const jargs = ['--user', '-u', systemdUnitName(kind, name), '-n', String(lines)]
    if (follow) jargs.push('-f')
    const child = spawn('journalctl', jargs, { stdio: 'inherit' })
    child.on('exit', (code) => process.exit(code ?? 0))
    return
  }

  const dir = logDirFor(kind, root)
  if (!existsSync(dir)) fail(`No log directory at ${shortenPath(dir)}.`)
  // Newest first: the supervisor's capture files sit beside the service's own
  // rotating log, and which one carries the interesting output depends on how it
  // was started.
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (candidates.length === 0) fail(`No log files in ${shortenPath(dir)}.`)
  const target = candidates[0]!.path
  const targs = follow ? ['-f', '-n', String(lines), target] : ['-n', String(lines), target]
  const child = spawn('tail', targs, { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
}

// ------------------------------------------------------------------ supervisor calls

/** A supervisor command failed. Carries its stderr so the caller can explain. */
export class SupervisorError extends Error {
  constructor(
    readonly command: string,
    readonly output: string
  ) {
    super(`${command} failed`)
  }
}

/**
 * Run a supervisor command, capturing stderr so a failure can be reported in
 * context rather than surfacing as a bare `Command failed: …`.
 */
function run(file: string, args: string[]): void {
  try {
    execFileSync(file, args, { stdio: ['ignore', 'inherit', 'pipe'] })
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string }).stderr
    throw new SupervisorError(
      `${file} ${args.join(' ')}`,
      (typeof stderr === 'string' ? stderr : stderr?.toString() ?? '').trim()
    )
  }
}

/** The launchd domain for user agents (`gui/<uid>`). */
function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? ''}`
}

/**
 * Register + start via the OS supervisor.
 *
 * Throws {@link SupervisorError} on failure so the caller can roll the registration
 * back and report properly — an uncaught execFileSync error would dump
 * `Command failed: systemctl --user daemon-reload` and leave a unit file behind with
 * nothing running.
 */
export function supervisorStart(
  kind: ServiceKind,
  backend: Exclude<ServiceBackend, 'none'>,
  name: string,
  unitFilePath: string
): void {
  if (backend === 'launchd') {
    const label = launchdLabel(kind, name)
    const domain = launchdDomain()
    // `bootout` first so a re-start picks up a rewritten plist instead of the
    // already-loaded old one. Failure is expected when nothing is loaded yet.
    try {
      execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' })
    } catch {
      /* not loaded — fine */
    }
    // `bootstrap` loads the plist AND starts it (RunAtLoad), so that is the whole
    // start. A `kickstart -k` after it would SIGTERM the process it just started
    // and boot a second one — visible as a `-15` last-exit-status on a job that is
    // otherwise healthy, plus two boot sequences in the log.
    run('launchctl', ['bootstrap', domain, unitFilePath])
    return
  }
  const unit = systemdUnitName(kind, name)
  run('systemctl', ['--user', 'daemon-reload'])
  run('systemctl', ['--user', 'enable', '--now', unit])
  // Without lingering, the user manager (and the service) dies at logout — the exact
  // failure "it stays up" is supposed to prevent. Best-effort: on some systems
  // this needs privileges we don't have, in which case the service still survives
  // crashes but not a logout.
  try {
    execFileSync('loginctl', ['enable-linger', process.env.USER ?? ''], { stdio: 'ignore' })
  } catch {
    console.log(
      `Note: could not enable systemd lingering — the ${kind} will stop when you log out.`
    )
    console.log(`  Fix with: sudo loginctl enable-linger ${process.env.USER ?? '<user>'}`)
  }
}

/** Stop + deregister from the OS supervisor. Best-effort per step. */
export function supervisorStop(
  kind: ServiceKind,
  backend: Exclude<ServiceBackend, 'none'>,
  name: string
): void {
  if (backend === 'launchd') {
    try {
      execFileSync('launchctl', ['bootout', `${launchdDomain()}/${launchdLabel(kind, name)}`], {
        stdio: 'ignore'
      })
    } catch {
      /* already gone */
    }
    return
  }
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', systemdUnitName(kind, name)], {
      stdio: 'ignore'
    })
  } catch {
    /* already gone */
  }
}

/**
 * Ask the supervisor to stop a unit, ignoring every failure.
 *
 * For `rm` on a service that is NOT running: the unit may be unloaded already, or the
 * bus may be unreachable entirely (the case that leaves a stale unit behind in the
 * first place). Neither must block removing the file.
 */
export function supervisorStopQuiet(
  kind: ServiceKind,
  backend: Exclude<ServiceBackend, 'none'>,
  name: string
): void {
  try {
    supervisorStop(kind, backend, name)
  } catch {
    /* the file removal the caller does next is what matters */
  }
}

/** What the supervisor believes about a registered service right now. */
export interface SupervisorStatus {
  running: boolean
  pid: number | null
  /** Last exit status the supervisor recorded, when it reports one. */
  lastExit: number | null
}

/**
 * Ask the supervisor whether a registered service is up, and under which pid.
 *
 * This is the RUNNER's substitute for `/health`. A hub binds a port and answers a
 * probe, so `hub ls` can discover it without asking any supervisor; a runner binds
 * nothing (it dials the hub), so the only local source of truth about whether its
 * process exists is the supervisor that owns it.
 *
 * Everything is best-effort: an unreadable/absent job is `{running: false, pid: null}`
 * rather than an error, because "registered but not running" is a normal state that
 * `ls` must be able to display.
 */
export function supervisorStatus(
  kind: ServiceKind,
  backend: ServiceBackend,
  name: string
): SupervisorStatus {
  const none: SupervisorStatus = { running: false, pid: null, lastExit: null }
  if (backend === 'none') return none
  if (backend === 'launchd') {
    let out: string
    try {
      // `launchctl list <label>` prints a plist-ish dict with PID + LastExitStatus.
      // A PID key is present ONLY while the job is actually running.
      out = execFileSync('launchctl', ['list', launchdLabel(kind, name)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return none
    }
    const pid = /"PID"\s*=\s*(\d+)/.exec(out)?.[1]
    const exit = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(out)?.[1]
    return {
      running: pid !== undefined,
      pid: pid === undefined ? null : Number(pid),
      lastExit: exit === undefined ? null : Number(exit)
    }
  }
  let out: string
  try {
    out = execFileSync(
      'systemctl',
      ['--user', 'show', systemdUnitName(kind, name), '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ExecMainStatus'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
  } catch {
    return none
  }
  const field = (key: string): string | undefined =>
    new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1]?.trim()
  const mainPid = Number(field('MainPID') ?? '0')
  const exit = field('ExecMainStatus')
  return {
    running: field('ActiveState') === 'active' && mainPid > 0,
    // MainPID is 0 for an inactive unit — report absence, not pid 0.
    pid: mainPid > 0 ? mainPid : null,
    lastExit: exit === undefined || exit === '' ? null : Number(exit)
  }
}
