/**
 * `slay hub` — the single control surface for hubs.
 *
 * TWO DISTINCT QUESTIONS, KEPT SEPARATE:
 *   - MACHINE view: which hubs are running here (`ls`, `start`, `stop`,
 *     `restart`, `logs`). Answered by probing the hub port block — see
 *     `@slayzone/platform/hub-discovery` for why a probe beats a pidfile.
 *   - CLIENT view: which hub THIS CLI talks to (`use`, `current`, `forget`).
 *     Answered from `hub.json` / `SLAYZONE_HUB_ADDRESS`.
 *
 * `start` REGISTERS the hub with the OS supervisor (launchd/systemd) rather than
 * merely backgrounding it, so a crash or a logout doesn't silently end the hub;
 * `stop` unregisters. There is no third "registered but stopped" state to reason
 * about. Foreground use is `npx @slayzone/hub` — the hub binary's only mode — so
 * no passthrough flag exists here.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { Command } from 'commander'
import { discoverHubs, findHub, type DiscoveredHub } from '@slayzone/platform/hub-discovery'
import {
  detectBackend,
  hubUnitPath,
  launchdLabel,
  listRegisteredHubs,
  readHubUnitRoot,
  removeHubUnit,
  systemdUnitName,
  writeHubUnit,
  type ServiceBackend
} from '@slayzone/platform/hub-service'
import {
  getHubConfigPath,
  normalizeHubUrl,
  removeHubConfig,
  resolveHubTarget,
  writeHubConfig
} from '../hub-config'
import { getDataDir, getServerPort, hasLocalDatabase } from '../db'

/** npm package providing the hub binary — resolved, never run through npx at
 *  supervisor-restart time (see hub-service's module note). */
const HUB_PACKAGE = '@slayzone/hub'

/** This CLI's version, substituted by build.mjs. The hub is released from the same
 *  repo at the same version, so it is what we install (see resolveHubBin). */
declare const __APP_VERSION__: string
const CLI_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/**
 * Ports worth probing beyond the hub block.
 *
 * The desktop app's sidecar does NOT bind inside the block — its supervisor takes
 * an OS-assigned port and publishes it to `settings.server_port`. Reading that key
 * is how the CLI has always located the app, so reuse it here: without this, the
 * app's hub is invisible to `hub ls` even though it is a hub on this machine.
 *
 * Best-effort by design — no app installed / no DB yet is the normal standalone
 * case, and a hub-only box must not need a SlayZone database to list its hubs.
 */
function outOfBlockPorts(): number[] {
  // MUST probe for the file first: getServerPort() → openDb(), which
  // `process.exit(1)`s when there is no database — a try/catch cannot intercept
  // that. A hub-only machine has no SlayZone DB and must still run `hub ls`.
  if (!hasLocalDatabase()) return []
  try {
    const port = getServerPort()
    return port ? [port] : []
  } catch {
    return []
  }
}

/** Discovery across the block PLUS the app's out-of-block sidecar port. */
function discoverAllHubs(): Promise<DiscoveredHub[]> {
  return discoverHubs({ extraPorts: outOfBlockPorts() })
}

/** findHub, but also aware of the app's out-of-block sidecar port. */
function findAnyHub(nameOrPort: string): Promise<DiscoveredHub | null> {
  return findHub(nameOrPort, { extraPorts: outOfBlockPorts() })
}

/** Human-readable duration for the `ls` table. */
function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Collapse `$HOME` to `~` so the root column stays readable. */
function shortenPath(path: string): string {
  const home = process.env.HOME ?? ''
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/**
 * Resolve a hub by name/port, exiting with a useful message when absent — every
 * command that takes a `<name|port>` needs the identical failure text.
 */
async function requireHub(nameOrPort: string): Promise<DiscoveredHub> {
  const hub = await findAnyHub(nameOrPort)
  if (!hub) {
    const running = await discoverAllHubs()
    const hint =
      running.length > 0
        ? `Running hubs: ${running.map((h) => `${h.name} (${h.port})`).join(', ')}`
        : 'No hubs are running on this machine.'
    fail(`No hub named or listening on "${nameOrPort}".\n${hint}`)
  }
  return hub
}

/**
 * The desktop app's own hub is off-limits to lifecycle commands: the app spawns
 * and owns that process, so stopping it from here breaks the running app while
 * leaving the app convinced its backend is alive.
 */
function refuseSupervised(hub: DiscoveredHub, verb: string): void {
  if (hub.supervised) {
    fail(
      `Refusing to ${verb} "${hub.name}" — it is the hub inside the SlayZone desktop app, ` +
        `which manages its own lifecycle. Quit the app instead.`
    )
  }
}

/** How to invoke a resolved hub bundle. */
interface HubBin {
  command: string
  args: string[]
  version: string
  /** Extra env the interpreter needs (Electron-ABI dev tree). */
  env?: Record<string, string>
}

/** Read `{version, bin}` out of a package.json, or null when it isn't usable. */
function readHubPkg(pkgJsonPath: string): { binPath: string; version: string } | null {
  let pkg: { version?: string; bin?: Record<string, string> | string }
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as typeof pkg
  } catch {
    return null
  }
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['slayzone-hub']
  if (!binRel) return null
  const binPath = join(dirname(pkgJsonPath), binRel)
  if (!existsSync(binPath)) return null
  return { binPath, version: pkg.version ?? 'unknown' }
}

/**
 * Pick the interpreter a given hub bundle can actually run under.
 *
 * A monorepo checkout's `better-sqlite3` is compiled for ELECTRON's ABI
 * (NODE_MODULE_VERSION 145 vs plain node's 137), so a dev-tree hub launched with
 * `node` dies instantly on `require('better-sqlite3')` — and under a supervisor
 * that means an invisible crash-loop. Such a bundle must run as
 * `ELECTRON_RUN_AS_NODE=1 <electron>`, which is exactly how the desktop app spawns
 * its own sidecar.
 *
 * An npm-INSTALLED hub rebuilds its natives for the consumer's node at install
 * time, so it runs under plain node. Detection is by locating an electron binary
 * in the same tree as the bundle: present ⇒ dev checkout, absent ⇒ installed
 * package.
 */
function interpreterFor(binPath: string, version: string): HubBin {
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
 * Absolute path to the hub bin — installing `@slayzone/hub` on demand if needed.
 *
 * The unit file must name a CONCRETE path: the supervisor re-executes this command
 * on every crash and every login, so an `npx` in there would mean a registry
 * round-trip (and possible silent version drift) per restart.
 *
 * Resolution order, each step deterministic:
 *   1. Node's own resolver (a global install, or a workspace checkout that lists
 *      the hub as a dependency).
 *   2. The dev tree — a sibling `packages/apps/hub/dist/bin.cjs` next to this
 *      CLI. The monorepo CLI does NOT depend on the hub package, so step 1 misses
 *      it, yet this is the build a developer means.
 *   3. `npm install` into a private prefix under the CLI's own state dir, then
 *      resolve inside it. NOT `npx --package … node -p require.resolve(…)`: npx
 *      exposes the package's BIN on PATH but does not add its cache to Node's
 *      module resolution paths, so that require.resolve fails even though the
 *      download succeeded.
 */
function resolveHubBin(): HubBin {
  // Test-only override: point `hub start` at a specific bundle so the failed-boot
  // rollback path can be exercised without a real hub. Never set in normal use.
  const override = process.env.SLZ_HUB_BIN
  if (override) return { command: process.execPath, args: [override], version: 'override' }

  const candidates: Array<() => string | null> = [
    // (1) Anchored on argv[1] (the slay script) — `import.meta` does not exist in
    // this package's CJS bundle.
    () => {
      try {
        return createRequire(process.argv[1] ?? join(process.cwd(), 'x')).resolve(
          `${HUB_PACKAGE}/package.json`
        )
      } catch {
        return null
      }
    },
    // (2) Dev tree: <cli>/dist/slay.js → ../../hub/package.json
    () => {
      const self = process.argv[1]
      if (!self) return null
      const sibling = join(dirname(self), '..', '..', 'hub', 'package.json')
      return existsSync(sibling) ? sibling : null
    }
  ]

  for (const find of candidates) {
    const path = find()
    if (!path) continue
    const found = readHubPkg(path)
    if (found) return interpreterFor(found.binPath, found.version)
  }

  // (3) Install into our own prefix so the result is resolvable by absolute path
  // — and stays put, since the unit file will reference it for every restart.
  //
  // PIN THE VERSION TO THIS CLI'S OWN. A bare `npm install @slayzone/hub` follows
  // the `latest` dist-tag, which for a pre-release line lags behind (npm refuses
  // `latest` for a prerelease, so beta versions are published under `beta` and
  // `latest` keeps pointing at whatever stable/older version was tagged last).
  // That silently paired a current CLI with a much older hub. The two are released
  // from one repo at one version, so requesting that exact version is both correct
  // and reproducible.
  const prefix = join(getDataDir(), 'hub-runtime')
  const installed = join(prefix, 'node_modules', HUB_PACKAGE, 'package.json')
  // Fall back to the `beta` tag rather than a bare name if the version define is
  // somehow missing: `latest` is the one thing that must never be followed here.
  const wanted = CLI_VERSION ? `${HUB_PACKAGE}@${CLI_VERSION}` : `${HUB_PACKAGE}@beta`
  if (!existsSync(installed) || (CLI_VERSION && readHubPkg(installed)?.version !== CLI_VERSION)) {
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
  const found = readHubPkg(installed)
  if (!found) {
    fail(
      `Installed ${HUB_PACKAGE} but found no usable bin at ${installed}. ` +
        `Install it globally and retry:\n  npm install -g ${HUB_PACKAGE}`
    )
  }
  // Invoke through an explicit interpreter rather than the bin's shebang: the
  // supervisor starts the unit with almost no PATH to find one on.
  return interpreterFor(found.binPath, found.version)
}

/** `<root>/storage/logs`, created so the supervisor can open its log files. */
function ensureLogDir(root: string): string {
  const dir = join(root, 'storage', 'logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Poll `/health` until the hub answers, or give up. Returns the hub or null. */
async function waitForHub(
  predicate: () => Promise<DiscoveredHub | null>,
  timeoutMs: number
): Promise<DiscoveredHub | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hub = await predicate()
    if (hub) return hub
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Wait for a hub to STOP answering, so `stop` can confirm rather than assume. */
async function waitForHubGone(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!(await findHub(String(port)))) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * Which service backend to use. `SLZ_FORCE_NO_SERVICE` is a test-only escape hatch
 * that forces the unsupervised path, so a test can exercise start/boot-failure
 * WITHOUT installing a launchd/systemd unit on the machine running it.
 */
function resolveBackend(): ServiceBackend {
  return process.env.SLZ_FORCE_NO_SERVICE === '1' ? 'none' : detectBackend()
}

/**
 * Bring a hub up: resolve its binary, write/refresh its unit, hand it to the
 * supervisor, and wait for `/health`.
 *
 * Shared by `create` (first time) and `start` (an existing, stopped hub) so the two
 * cannot drift on the parts that must match — the interpreter pairing, the log
 * directory, the failure reporting. `creating` only affects wording and whether a
 * failed boot rolls the registration back.
 */
async function launchHub(args: {
  name: string
  root: string
  port?: number
  backend: ServiceBackend
  creating: boolean
}): Promise<void> {
  const { name, root, port, backend, creating } = args
  const bin = resolveHubBin()
  const logDir = ensureLogDir(root)
  const findIt = (): Promise<DiscoveredHub | null> =>
    port === undefined ? findAnyHub(name) : findHub(String(port))

  if (backend === 'none') {
    // No user-level supervisor (Windows today). Background it anyway, but never let
    // the operator believe it is supervised.
    const out = openSync(join(logDir, 'hub.out.log'), 'a')
    const child = spawn(bin.command, bin.args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        SLAYZONE_ROOT: root,
        SLAYZONE_HUB_NAME: name,
        ...(port === undefined ? {} : { SLAYZONE_HUB_ADDRESS: `127.0.0.1:${port}` }),
        // Same interpreter requirement as the unit path: a dev-tree hub needs
        // ELECTRON_RUN_AS_NODE or its Electron-ABI natives fail to load.
        ...(bin.env ?? {})
      }
    })
    child.unref()
    const started = await waitForHub(findIt, 20_000)
    if (!started) failWithLog(name, join(logDir, 'hub.out.log'), 'did not come up within 20s')
    console.log(`Hub "${started.name}" started on port ${started.port} (pid ${started.pid}).`)
    console.log(`  Root:  ${shortenPath(root)}`)
    console.log(`  Logs:  ${shortenPath(logDir)}`)
    console.log(
      'Note: this platform has no user service manager, so the hub will NOT restart ' +
        'if it crashes, and will not come back after a reboot.'
    )
    return
  }

  const unitPath = writeHubUnit(
    {
      name,
      root,
      command: bin.command,
      args: bin.args,
      logDir,
      ...(port ? { port } : {}),
      ...(bin.env ? { env: bin.env } : {})
    },
    backend
  )
  // Say what is happening BEFORE the wait: registration is a real side effect, and
  // the wait can take seconds. Silence here reads as "nothing happened" while the
  // supervisor may already be crash-looping the hub.
  if (creating) console.log(`Registered ${unitPath}`)
  console.log(`Starting hub "${name}" (${HUB_PACKAGE}@${bin.version})…`)
  try {
    supervisorStart(backend, name, unitPath)
  } catch (e) {
    // The supervisor refused. Never leave a unit file behind for a hub that was
    // never started — `registered` would list a hub that does not exist.
    if (creating) removeHubUnit(name, backend)
    if (!(e instanceof SupervisorError)) throw e
    // A systemd USER manager needs a login session bus. On a VPS/container there
    // often is none, and every `--user` call fails this way. Name the actual fix
    // rather than echoing "Command failed".
    const noBus = /Failed to connect to bus|No medium found/i.test(e.output)
    fail(
      `Could not register hub "${name}" with ${backend}.\n\n` +
        `  ${e.command}\n  ${e.output || '(no output)'}\n\n` +
        (noBus
          ? `systemd has no user session bus for this account, so \`systemctl --user\` ` +
            `cannot work. Enable a persistent user manager:\n` +
            `  sudo loginctl enable-linger ${process.env.USER ?? '<user>'}\n` +
            `then log out and back in, and retry. If this account is not meant to have ` +
            `one (a container, or a root-only box), run the hub under the system ` +
            `manager or in the foreground instead:\n` +
            `  npx ${HUB_PACKAGE}\n`
          : '')
    )
  }

  const started = await waitForHub(findIt, 20_000)
  if (!started) {
    if (creating) {
      // A failed FIRST boot must not leave a registered, crash-looping unit behind:
      // the supervisor would retry it forever, invisibly, and the operator was given
      // no working hub. An existing hub's unit is left alone — the operator may want
      // to fix its root and `start` again.
      supervisorStop(backend, name)
      removeHubUnit(name, backend)
    } else {
      supervisorStop(backend, name)
    }
    failWithLog(
      name,
      join(logDir, 'hub.err.log'),
      creating
        ? 'failed to start, so it was unregistered again'
        : 'failed to start (its registration was left in place)'
    )
  }
  console.log(`Hub "${started.name}" running on port ${started.port} (pid ${started.pid}).`)
  console.log(`  Root:  ${shortenPath(root)}`)
  console.log(`  Logs:  ${shortenPath(logDir)}`)
  console.log(`  Unit:  ${unitPath}`)
  console.log(`  Hub:   ${HUB_PACKAGE}@${bin.version}`)
  // State exactly what the supervisor guarantees. A user agent starts at LOGIN, not
  // at boot — claiming "survives reboot" would be wrong.
  console.log('Restarts automatically if it crashes, and starts again when you log in.')
}

/**
 * Bring a hub down, optionally removing its registration.
 *
 * Goes through the SUPERVISOR when one owns this hub — signalling the pid directly
 * would just be undone, since launchd/systemd relaunch on a non-clean exit. Only a
 * hub with no unit (docker, a hand-written unit, a bare run) is signalled by pid,
 * using the pid `/health` reported.
 *
 * `unregister: false` keeps the unit so `hub start` can bring it back; note that
 * `launchctl bootout` also unloads the plist, so the FILE remaining is what
 * "registered but stopped" means on macOS — `hub start` bootstraps it again.
 */
async function haltHub(
  hub: DiscoveredHub,
  backend: ServiceBackend,
  opts: { unregister: boolean }
): Promise<void> {
  if (backend !== 'none' && existsSync(hubUnitPath(hub.name, backend))) {
    supervisorStop(backend, hub.name)
    if (opts.unregister) removeHubUnit(hub.name, backend)
  } else {
    try {
      process.kill(hub.pid, 'SIGTERM')
    } catch (e) {
      fail(`Could not signal pid ${hub.pid}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const gone = await waitForHubGone(hub.port, 15_000)
  if (!gone) {
    fail(
      `Hub "${hub.name}" is still answering on port ${hub.port} after 15s. ` +
        `It may be managed elsewhere (docker, a system unit).`
    )
  }
}

/** A supervisor command failed. Carries its stderr so the caller can explain. */
class SupervisorError extends Error {
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

/**
 * Fail, quoting the tail of the hub's own output. Pointing at a log file and making
 * the operator go read it is a worse experience than just showing the reason.
 */
function failWithLog(name: string, logPath: string, what: string): never {
  let detail = ''
  try {
    detail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-12).join('\n')
  } catch {
    /* nothing captured */
  }
  fail(
    `Hub "${name}" ${what}.\n` +
      (detail
        ? `\nLast output (${shortenPath(logPath)}):\n${detail}\n`
        : `\nNo output was captured in ${shortenPath(logPath)}.\n`)
  )
}

/**
 * Register + start via the OS supervisor.
 *
 * Throws {@link SupervisorError} on failure so the caller can roll the
 * registration back and report properly — an uncaught execFileSync error would
 * dump `Command failed: systemctl --user daemon-reload` and leave a unit file
 * behind with nothing running.
 */
function supervisorStart(
  backend: Exclude<ServiceBackend, 'none'>,
  name: string,
  unitPath: string
): void {
  if (backend === 'launchd') {
    const label = launchdLabel(name)
    const domain = `gui/${process.getuid?.() ?? ''}`
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
    run('launchctl', ['bootstrap', domain, unitPath])
    return
  }
  const unit = systemdUnitName(name)
  run('systemctl', ['--user', 'daemon-reload'])
  run('systemctl', ['--user', 'enable', '--now', unit])
  // Without lingering, the user manager (and the hub) dies at logout — the exact
  // failure "it stays up" is supposed to prevent. Best-effort: on some systems
  // this needs privileges we don't have, in which case the hub still survives
  // crashes but not a logout.
  try {
    execFileSync('loginctl', ['enable-linger', process.env.USER ?? ''], { stdio: 'ignore' })
  } catch {
    console.log('Note: could not enable systemd lingering — the hub will stop when you log out.')
    console.log(`  Fix with: sudo loginctl enable-linger ${process.env.USER ?? '<user>'}`)
  }
}

/**
 * Ask the supervisor to stop a unit, ignoring every failure.
 *
 * For `rm` on a hub that is NOT running: the unit may be unloaded already, or the
 * bus may be unreachable entirely (the case that leaves a stale unit behind in the
 * first place). Neither must block removing the file.
 */
function supervisorStopQuiet(backend: Exclude<ServiceBackend, 'none'>, name: string): void {
  try {
    supervisorStop(backend, name)
  } catch {
    /* the file removal below is what matters */
  }
}

/** Stop + deregister from the OS supervisor. Best-effort per step. */
function supervisorStop(backend: Exclude<ServiceBackend, 'none'>, name: string): void {
  if (backend === 'launchd') {
    const domain = `gui/${process.getuid?.() ?? ''}`
    try {
      execFileSync('launchctl', ['bootout', `${domain}/${launchdLabel(name)}`], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
    return
  }
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', systemdUnitName(name)], {
      stdio: 'ignore'
    })
  } catch {
    /* already gone */
  }
}

export function hubCommand(): Command {
  const cmd = new Command('hub')
    .description('Run, list and target SlayZone hubs')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // ---------------------------------------------------------------- machine view

  // slay hub ls
  cmd
    .command('ls')
    .description('List the hubs running on this machine')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const hubs = await discoverAllHubs()
      if (opts.json) {
        console.log(JSON.stringify(hubs, null, 2))
        return
      }
      if (hubs.length === 0) {
        console.log('No hubs running. Create one with `slay hub create <name>`.')
        return
      }
      const nameW = Math.max(4, ...hubs.map((h) => h.name.length))
      const rootW = Math.max(
        4,
        ...hubs.map((h) => (h.supervised ? '(desktop app)'.length : shortenPath(h.root).length))
      )
      console.log(
        `${'NAME'.padEnd(nameW)}  ${'PORT'.padEnd(5)}  ${'PID'.padEnd(7)}  ` +
          `${'ROOT'.padEnd(rootW)}  ${'RUNNERS'.padEnd(7)}  UPTIME`
      )
      console.log(
        `${'-'.repeat(nameW)}  ${'-'.repeat(5)}  ${'-'.repeat(7)}  ${'-'.repeat(rootW)}  ` +
          `${'-'.repeat(7)}  ${'-'.repeat(8)}`
      )
      for (const h of hubs) {
        // The app's hub has a platform state dir for a root; showing that path
        // would imply it is a hub you could cd into and manage.
        const root = h.supervised ? '(desktop app)' : shortenPath(h.root)
        console.log(
          `${h.name.padEnd(nameW)}  ${String(h.port).padEnd(5)}  ${String(h.pid).padEnd(7)}  ` +
            `${root.padEnd(rootW)}  ${String(h.runnersConnected).padEnd(7)}  ` +
            `${formatUptime(h.uptimeMs)}`
        )
      }
    })

  // slay hub create <name>
  cmd
    .command('create <name>')
    .description('Create a hub here and keep it running (crash-restart + start at login)')
    .option('--root <dir>', 'Hub root — its config, storage and logs (default: cwd)')
    .option('--port <port>', 'Bind a specific port (default: first free hub port)')
    .action(async (name: string, opts: { root?: string; port?: string }) => {
      const root = resolvePath(opts.root ?? process.cwd())
      const port = opts.port === undefined ? undefined : Number(opts.port)
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        fail(`Invalid --port ${opts.port} — expected an integer 1-65535.`)
      }
      const backend = resolveBackend()

      // A name identifies a hub for every other command, so it must be unique —
      // and "unique" has to include a hub that is REGISTERED BUT NOT RUNNING
      // (stopped, or crashed). Checking only running hubs would let `create`
      // silently overwrite an existing hub's unit.
      if (backend !== 'none' && existsSync(hubUnitPath(name, backend))) {
        const existingRoot = readHubUnitRoot(name, backend)
        fail(
          `A hub named "${name}" already exists${
            existingRoot ? ` (root ${shortenPath(existingRoot)})` : ''
          }.\n` +
            `Start it with \`slay hub start ${name}\`, or remove it with ` +
            `\`slay hub rm ${name}\`.`
        )
      }
      // Pre-flight against reality too: a hub may occupy this root or name having
      // been started some other way entirely (docker, a hand-written unit).
      const running = await discoverAllHubs()
      const sameRoot = running.find((h) => h.root === root)
      if (sameRoot) {
        fail(
          `A hub is already running in ${shortenPath(root)} — "${sameRoot.name}" on port ` +
            `${sameRoot.port} (pid ${sameRoot.pid}).`
        )
      }
      const sameName = running.find((h) => h.name === name)
      if (sameName) {
        fail(
          `A hub named "${name}" is already running (root ${shortenPath(sameName.root)}). ` +
            `Choose another name.`
        )
      }

      await launchHub({ name, root, port, backend, creating: true })
    })

  // slay hub start <name>
  cmd
    .command('start <name>')
    .description('Start an existing hub that is stopped')
    .action(async (name: string) => {
      const backend = resolveBackend()
      // ALREADY RUNNING is checked FIRST, before any registration lookup: a hub
      // that is up plainly exists, whatever started it, so "no hub named …" would
      // be a lie. Reporting it and stopping is deliberately NOT a restart —
      // bouncing a live hub drops its connected runners and pty sessions, which is
      // not what someone typing `start` on a running hub wants. Use `restart`.
      const live = await findAnyHub(name)
      if (live) {
        console.log(
          `Hub "${live.name}" is already running on port ${live.port} (pid ${live.pid}).`
        )
        return
      }
      if (backend === 'none') {
        fail(
          `This platform has no user service manager, so hubs are not registered ` +
            `and \`start\` has nothing to act on. Use \`slay hub create ${name}\`.`
        )
      }
      if (!existsSync(hubUnitPath(name, backend))) {
        fail(
          `No hub named "${name}". Create it with \`slay hub create ${name}\`, ` +
            `or list what exists with \`slay hub registered\`.`
        )
      }
      const root = readHubUnitRoot(name, backend)
      if (!root) {
        fail(
          `The unit for "${name}" does not record a root — it may be hand-edited. ` +
            `Remove it with \`slay hub rm ${name}\` and create it again.`
        )
      }
      await launchHub({ name, root, backend, creating: false })
    })

  // slay hub stop
  cmd
    .command('stop <name|port>')
    .description('Stop a hub, keeping it registered so `start` can bring it back')
    .action(async (nameOrPort: string) => {
      const hub = await requireHub(nameOrPort)
      refuseSupervised(hub, 'stop')
      const backend = resolveBackend()
      const registered = backend !== 'none' && existsSync(hubUnitPath(hub.name, backend))
      await haltHub(hub, backend, { unregister: false })
      console.log(
        registered
          ? `Stopped "${hub.name}". Start it again with \`slay hub start ${hub.name}\`.`
          : `Stopped "${hub.name}" (pid ${hub.pid}). It was not registered by slay.`
      )
    })

  // slay hub rm
  cmd
    .command('rm <name|port>')
    .description('Stop a hub and remove its registration')
    .action(async (nameOrPort: string) => {
      const backend = resolveBackend()
      const hub = await findAnyHub(nameOrPort)

      // NOT running, but registered? That is the main thing `rm` is for — a hub
      // that failed to boot, or was stopped and is no longer wanted. Requiring a
      // LIVE hub here left the operator with a unit file they could only delete by
      // hand, and `create` refusing the name because of it.
      if (!hub) {
        if (backend !== 'none' && existsSync(hubUnitPath(nameOrPort, backend))) {
          const root = readHubUnitRoot(nameOrPort, backend)
          supervisorStopQuiet(backend, nameOrPort)
          removeHubUnit(nameOrPort, backend)
          console.log(
            `Removed "${nameOrPort}" (it was not running).` +
              (root ? ` Its data is still in ${shortenPath(root)}.` : '')
          )
          return
        }
        // Neither running nor registered — reuse the standard not-found message.
        await requireHub(nameOrPort)
        return
      }

      refuseSupervised(hub, 'remove')
      await haltHub(hub, backend, { unregister: true })
      // The hub's ROOT (db, artifacts, logs) is deliberately left on disk: it is the
      // operator's data, and `rm` was asked to remove a hub's registration, not to
      // delete their store.
      console.log(`Removed "${hub.name}". Its data is still in ${shortenPath(hub.root)}.`)
    })

  // slay hub restart
  cmd
    .command('restart <name|port>')
    .description('Restart a hub')
    .option('--upgrade', `Re-resolve ${HUB_PACKAGE} first (picks up a newer version)`)
    .action(async (nameOrPort: string, opts: { upgrade?: boolean }) => {
      const hub = await requireHub(nameOrPort)
      refuseSupervised(hub, 'restart')
      const backend = resolveBackend()
      if (backend === 'none' || !existsSync(hubUnitPath(hub.name, backend))) {
        fail(
          `"${hub.name}" is not managed by slay, so it cannot be restarted from here. ` +
            `Stop it where it was started, then \`slay hub create ${hub.name}\`.`
        )
      }

      const { name, root } = hub
      const logDir = ensureLogDir(root)
      // --upgrade re-resolves the package so the unit points at the new version;
      // without it the existing unit is reused verbatim.
      if (opts.upgrade) {
        const bin = resolveHubBin()
        writeHubUnit(
          {
            name,
            root,
            command: bin.command,
            args: bin.args,
            logDir,
            // Must carry the interpreter env: dropping it here would rewrite a
            // working unit into one that crash-loops on Electron-ABI natives.
            ...(bin.env ? { env: bin.env } : {})
          },
          backend
        )
        console.log(`Unit updated to ${HUB_PACKAGE}@${bin.version}.`)
      }
      supervisorStop(backend, name)
      await waitForHubGone(hub.port, 15_000)
      supervisorStart(backend, name, hubUnitPath(name, backend))
      const back = await waitForHub(() => findHub(name), 20_000)
      if (!back) fail(`Hub "${name}" did not come back within 20s. Check ${shortenPath(logDir)}.`)
      console.log(`Hub "${back.name}" restarted on port ${back.port} (pid ${back.pid}).`)
    })

  // slay hub logs
  cmd
    .command('logs <name|port>')
    .description("Show a hub's log output")
    .option('-n, --lines <n>', 'Last N lines', '50')
    .option('-f, --follow', 'Follow the log')
    .action(async (nameOrPort: string, opts: { lines: string; follow?: boolean }) => {
      const hub = await requireHub(nameOrPort)
      const lines = Number(opts.lines)
      if (!Number.isInteger(lines) || lines < 1) fail(`Invalid --lines ${opts.lines}.`)

      // systemd captures stdout into journald rather than a file, so the unit's
      // own output is only readable there.
      const backend = detectBackend()
      if (backend === 'systemd' && existsSync(hubUnitPath(hub.name, backend))) {
        const args = ['--user', '-u', systemdUnitName(hub.name), '-n', String(lines)]
        if (opts.follow) args.push('-f')
        const child = spawn('journalctl', args, { stdio: 'inherit' })
        child.on('exit', (code) => process.exit(code ?? 0))
        return
      }

      const logDir = join(hub.root, 'storage', 'logs')
      if (!existsSync(logDir)) fail(`No log directory at ${shortenPath(logDir)}.`)
      // Newest first: the supervisor's capture files sit beside the hub's own
      // rotating log, and which one carries the interesting output depends on how
      // the hub was started.
      const candidates = readdirSync(logDir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => ({ f, path: join(logDir, f), mtime: statSync(join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (candidates.length === 0) fail(`No log files in ${shortenPath(logDir)}.`)
      const target = candidates[0]!.path
      const args = opts.follow ? ['-f', '-n', String(lines), target] : ['-n', String(lines), target]
      const child = spawn('tail', args, { stdio: 'inherit' })
      child.on('exit', (code) => process.exit(code ?? 0))
    })

  // ----------------------------------------------------------------- client view

  // slay hub use <name|url>
  cmd
    .command('use <name|url>')
    .description('Point this CLI at a hub — a name from `hub ls`, or a full URL')
    .option('--token <token>', 'Bearer token sent as Authorization header')
    .action(async (target: string, opts: { token?: string }) => {
      // A bare name/port means "one of the hubs on this machine" — resolve it so
      // the operator never has to look up a port by hand.
      const looksLikeUrl = target.includes('://')
      const url = looksLikeUrl
        ? normalizeHubUrl(target)
        : `http://127.0.0.1:${(await requireHub(target)).port}`
      if (!url) fail(`Invalid hub URL (expected an http(s) URL): ${target}`)

      const configPath = writeHubConfig(url, opts.token ?? null)
      console.log(`Now targeting: ${url}`)
      console.log(`Config written: ${configPath}`)
      if (process.env.SLAYZONE_HUB_ADDRESS) {
        console.error('Note: SLAYZONE_HUB_ADDRESS is set and takes precedence over this config.')
      }
    })

  // slay hub current
  cmd
    .command('current')
    .description('Show which hub this CLI targets, and probe it')
    .action(async () => {
      const target = resolveHubTarget()
      if (!target) {
        console.log('No hub configured — using the local app.')
        return
      }
      const source = process.env.SLAYZONE_HUB_ADDRESS
        ? 'SLAYZONE_HUB_ADDRESS env'
        : getHubConfigPath()
      console.log(`Hub:    ${target.baseUrl}`)
      console.log(`Source: ${source}`)
      console.log(`Token:  ${target.token ? 'set' : 'not set'}`)
      try {
        const headers: Record<string, string> = target.token
          ? { Authorization: `Bearer ${target.token}` }
          : {}
        const res = await fetch(`${target.baseUrl}/health`, {
          headers,
          signal: AbortSignal.timeout(5000)
        })
        if (res.ok) {
          console.log(`Health: ok (HTTP ${res.status})`)
        } else {
          console.error(`Health: failed (HTTP ${res.status})`)
          process.exit(1)
        }
      } catch {
        console.error(`Health: unreachable (could not connect to ${target.baseUrl})`)
        process.exit(1)
      }
    })

  // slay hub forget
  cmd
    .command('forget')
    .description('Drop the stored hub target (back to the local app)')
    .action(() => {
      const removed = removeHubConfig()
      console.log(removed ? `Removed: ${getHubConfigPath()}` : 'No hub target to remove.')
      if (process.env.SLAYZONE_HUB_ADDRESS) {
        console.error('Note: SLAYZONE_HUB_ADDRESS is still set in the environment.')
      }
    })

  // slay hub registered — which hubs have a unit file, running or not. Useful when
  // a hub failed to boot: it is registered but absent from `ls`.
  cmd
    .command('registered')
    .description('List hubs registered with the OS service manager')
    .action(async () => {
      const backend = detectBackend()
      if (backend === 'none') {
        console.log('This platform has no user service manager — no hubs can be registered.')
        return
      }
      const units = listRegisteredHubs(backend)
      if (units.length === 0) {
        console.log('No registered hubs.')
        return
      }
      const live = new Set((await discoverAllHubs()).map((h) => h.name))
      // "registered but stopped" is a normal state now (`hub stop` keeps the unit),
      // so name the remedy rather than just flagging it.
      for (const u of units) {
        const running = live.has(u.name)
        console.log(`${u.name}${running ? '  (running)' : '  (stopped)'}`)
        console.log(`  ${u.unitPath}`)
        const root = readHubUnitRoot(u.name, backend)
        if (root) console.log(`  root: ${shortenPath(root)}`)
        if (!running) console.log(`  start: slay hub start ${u.name}`)
      }
    })

  return cmd
}
