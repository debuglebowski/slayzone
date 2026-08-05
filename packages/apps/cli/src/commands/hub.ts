/**
 * `slay hub` — the single control surface for hubs.
 *
 * TWO DISTINCT QUESTIONS, KEPT SEPARATE:
 *   - MACHINE view: which hubs are running here (`ls`, `start`, `stop`,
 *     `restart`, `logs`). Answered by probing the hub port block — see
 *     `@slayzone/platform/hub-discovery` for why a probe beats a pidfile.
 *   - CLIENT view: which hub THIS CLI talks to (`use`, `login`, `current`,
 *     `forget`). Answered from `cli-hub-target.json` / `SLAYZONE_HUB_ADDRESS`. `use` points at
 *     a hub; `login` additionally OBTAINS the bearer an auth-enforcing hub needs.
 *   - ACCOUNTS on a hub (`users add|ls|rm`). Reaches the hub's loopback-only
 *     `/api/hub/users` — see {@link hubUsersCommand}.
 *
 * `start` REGISTERS the hub with the OS supervisor (launchd/systemd) rather than
 * merely backgrounding it, so a crash or a logout doesn't silently end the hub;
 * `stop` unregisters. There is no third "registered but stopped" state to reason
 * about. Foreground use is `npx @slayzone/hub` — the hub binary's only mode — so
 * no passthrough flag exists here.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { Command } from 'commander'
import { discoverHubs, findHub, type DiscoveredHub } from '@slayzone/platform/hub-discovery'
import { isBareAuthority, parseHubAddress } from '@slayzone/platform/hub-addr'
import { updateHubConfigFile } from '@slayzone/platform/slayzone-config'
import {
  detectBackend,
  listRegisteredUnits,
  readUnitRoot,
  removeUnit,
  unitPath,
  writeUnit,
  type ServiceBackend
} from '@slayzone/platform/service-unit'
import {
  getHubConfigPath,
  normalizeHubUrl,
  removeHubConfig,
  resolveHubTarget,
  writeHubConfig
} from '../hub-config'
import { hubRequest, resolveHubRequestTarget } from '../hub-request'
import {
  ensureLogDir,
  fail,
  failWithLog,
  followServiceLog,
  resolveBackend,
  resolveServiceBin,
  servicePackage,
  serviceLogPaths,
  shortenPath,
  SupervisorError,
  supervisorStart,
  supervisorStop,
  supervisorStopQuiet
} from '../service'

/** npm package providing the hub binary — resolved, never run through npx at
 *  supervisor-restart time (see service-unit's module note). */
const HUB_PACKAGE = servicePackage('hub')

/**
 * Every live hub on this machine, the desktop app's sidecar included.
 *
 * No `extraPorts` special case anymore: the supervised sidecar now binds a fixed
 * port in the reserved head of the hub block (`SIDECAR_FIXED_PORT`), so the
 * ordinary block sweep sees it like any other hub. This used to read
 * `settings.server_port` out of SQLite to learn the sidecar's OS-assigned port,
 * which is why it first had to probe for a database file at all — `openDb()`
 * `process.exit(1)`s when one is absent, the normal state of a hub-only box, and
 * a try/catch cannot intercept an exit.
 */
function discoverAllHubs(): Promise<DiscoveredHub[]> {
  return discoverHubs()
}

/** findHub over the same block. */
function findAnyHub(nameOrPort: string): Promise<DiscoveredHub | null> {
  return findHub(nameOrPort)
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
 * Bring a hub up: resolve its binary, write/refresh its unit, hand it to the
 * supervisor, and wait for `/health`.
 *
 * Shared by `create` (first time) and `start` (an existing, stopped hub) so the two
 * cannot drift on the parts that must match — the interpreter pairing, the log
 * directory, the failure reporting. `creating` only affects wording and whether a
 * failed boot rolls the registration back.
 */
/**
 * SIGTERM a child we spawned, escalating to SIGKILL if it does not go quietly.
 * Best-effort: the caller is already on a failure path and must not be blocked by
 * a wedged child, so this always resolves.
 */
async function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const hard = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve()
    }, graceMs)
    child.once('exit', () => {
      clearTimeout(hard)
      resolve()
    })
    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(hard)
      resolve()
    }
  })
}

async function launchHub(args: {
  name: string
  root: string
  port?: number
  /** Full bind authority (`host[:port]`), from `--bind` / a remote `create`. Wins
   *  over `port`, which can only ever mean loopback. */
  address?: string
  backend: ServiceBackend
  creating: boolean
}): Promise<void> {
  const { name, root, port, address, backend, creating } = args
  const bin = resolveServiceBin('hub')
  const logDir = ensureLogDir('hub', root)
  const logs = serviceLogPaths('hub', root)
  // Which port to probe for. Discovery only ever dials 127.0.0.1, which still
  // reaches a wildcard bind (0.0.0.0 includes loopback) — so an explicit `--bind`
  // is discoverable exactly like a loopback one. A host-only authority names no
  // port, so fall back to finding the hub by name.
  const probePort = address !== undefined ? parseHubAddress(address)?.port : port
  const findIt = (): Promise<DiscoveredHub | null> =>
    probePort === undefined ? findAnyHub(name) : findHub(String(probePort))

  if (backend === 'none') {
    // No user-level supervisor (Windows today). Background it anyway, but never let
    // the operator believe it is supervised.
    const out = openSync(logs.out, 'a')
    const child = spawn(bin.command, bin.args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        SLAYZONE_ROOT: root,
        SLAYZONE_HUB_NAME: name,
        // Same precedence as the unit path (see unitEnv): an explicit authority
        // wins, else the legacy loopback-from-port form.
        ...(address !== undefined
          ? { SLAYZONE_HUB_ADDRESS: address }
          : port === undefined
            ? {}
            : { SLAYZONE_HUB_ADDRESS: `127.0.0.1:${port}` }),
        // Same interpreter requirement as the unit path: a dev-tree hub needs
        // ELECTRON_RUN_AS_NODE or its Electron-ABI natives fail to load.
        ...(bin.env ?? {})
      }
    })
    child.unref()
    const started = await waitForHub(findIt, 20_000)
    if (!started) {
      // Kill what we spawned before declaring failure. This backend has NO service
      // manager to own the child, and `failWithLog` exits the process — so a hub
      // left running here belongs to nobody. Worse, the reason it wasn't found is
      // usually that it is undiscoverable (an OS-assigned port, a bind the sweep
      // can't reach), which is exactly the state in which `hub stop <name>` cannot
      // clean it up either. Left unkilled these accumulated for days.
      await terminateChild(child, 3_000)
      failWithLog('hub', name, logs.out, 'did not come up within 20s')
    }
    console.log(`Hub "${started.name}" started on port ${started.port} (pid ${started.pid}).`)
    console.log(`  Root:  ${shortenPath(root)}`)
    console.log(`  Logs:  ${shortenPath(logDir)}`)
    console.log(
      'Note: this platform has no user service manager, so the hub will NOT restart ' +
        'if it crashes, and will not come back after a reboot.'
    )
    return
  }

  const writtenUnitPath = writeUnit(
    {
      kind: 'hub',
      name,
      root,
      command: bin.command,
      args: bin.args,
      logDir,
      ...(port ? { port } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(bin.env ? { env: bin.env } : {})
    },
    backend
  )
  // Say what is happening BEFORE the wait: registration is a real side effect, and
  // the wait can take seconds. Silence here reads as "nothing happened" while the
  // supervisor may already be crash-looping the hub.
  if (creating) console.log(`Registered ${writtenUnitPath}`)
  console.log(`Starting hub "${name}" (${HUB_PACKAGE}@${bin.version})…`)
  try {
    supervisorStart('hub', backend, name, writtenUnitPath)
  } catch (e) {
    // The supervisor refused. Never leave a unit file behind for a hub that was
    // never started — `registered` would list a hub that does not exist.
    if (creating) removeUnit('hub', name, backend)
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
      supervisorStop('hub', backend, name)
      removeUnit('hub', name, backend)
    } else {
      supervisorStop('hub', backend, name)
    }
    failWithLog(
      'hub',
      name,
      logs.err,
      creating
        ? 'failed to start, so it was unregistered again'
        : 'failed to start (its registration was left in place)'
    )
  }
  console.log(`Hub "${started.name}" running on port ${started.port} (pid ${started.pid}).`)
  console.log(`  Root:  ${shortenPath(root)}`)
  console.log(`  Logs:  ${shortenPath(logDir)}`)
  console.log(`  Unit:  ${writtenUnitPath}`)
  console.log(`  Hub:   ${HUB_PACKAGE}@${bin.version}`)
  // State exactly what the supervisor guarantees. A user agent starts at LOGIN, not
  // at boot — claiming "survives reboot" would be wrong.
  console.log('Restarts automatically if it crashes, and starts again when you log in.')
  // A brand-new hub has NO accounts, and public signup is closed — so on a remote
  // deployment nobody can sign in until the operator creates one here, on the box.
  // A loopback-only hub needs no account at all, hence "if this hub is reachable
  // from other machines" rather than an unconditional instruction.
  if (creating) {
    console.log('')
    console.log('If this hub is reachable from other machines, create an account for it:')
    console.log(`  slay hub users add <email> --hub ${name}`)
  }
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
  if (backend !== 'none' && existsSync(unitPath('hub', hub.name, backend))) {
    supervisorStop('hub', backend, hub.name)
    if (opts.unregister) removeUnit('hub', hub.name, backend)
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

// ------------------------------------------------------------------- accounts
//
// `slay hub users` talks to the hub's loopback-only `/api/hub/users`. That route is
// the ONLY way to create an account: public signup is closed on the hub
// (`disableSignUp`), because the sign-up endpoint has to stay reachable without a
// bearer and therefore made any reachable hub self-registerable. Being on the box —
// typically SSH'd into the VPS — is the authority here.

/** Shape the routes return on success. */
interface HubUserRow {
  id: string
  email: string
  name: string
  createdAt: string
}

/**
 * Read a password from stdin when it was not passed as a flag. Returns '' when
 * stdin is a TTY (nothing piped) so the caller can print the usage hint — the CLI
 * never renders an interactive prompt here, so a bare invocation must not hang
 * waiting on a keystroke that will never come in a script.
 */
async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  // Strip the trailing newline `echo` adds — a password is never meant to carry it.
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '')
}

/**
 * Exchange an email + password for a hub bearer token via better-auth.
 *
 * Mirrors the desktop app's `hubLogin` (main/boot-config.ts): POST
 * `/api/auth/sign-in/email`, take the token from the `set-auth-token` response
 * header the bearer plugin sets, falling back to a `token` field in the body. That
 * route is deliberately gate-exempt (`AUTH_BOOTSTRAP_PREFIX`) — it has to be
 * reachable without a credential, or a hub could never be authenticated at all.
 */
async function hubSignIn(baseUrl: string, email: string, password: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    fail(`Could not reach the hub at ${baseUrl}.`)
  }
  if (!res.ok) {
    // better-auth answers 401 for both a wrong password and an unknown email, and
    // deliberately does not distinguish them. Name the likely fixes instead of
    // guessing which one it was.
    fail(
      `Sign-in failed (HTTP ${res.status}).\n` +
        `Check the email and password. List the accounts on the hub box with ` +
        `\`slay hub users ls\`, or create one with \`slay hub users add <email>\`.`
    )
  }
  const header = res.headers.get('set-auth-token')
  if (header) return header
  const body = (await res.json().catch(() => ({}))) as { token?: unknown }
  if (typeof body.token === 'string' && body.token) return body.token
  fail('The hub accepted the sign-in but returned no token.')
}

/**
 * Call `/api/hub/users` and return the parsed `data`, or exit with the hub's own
 * error text. Resolution + error surfacing live in `../hub-request` — shared with
 * `slay runner mint`, which needs the identical "which hub, what credential"
 * answer (see that module's note).
 *
 * `discoverAllHubs` is passed in so the sweep also sees the desktop app's
 * out-of-block sidecar port.
 */
function hubUsersRequest<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  return resolveHubRequestTarget('hub users …', discoverAllHubs).then((target) =>
    hubRequest<T>({
      target,
      path: '/api/hub/users',
      method,
      ...(body === undefined ? {} : { body }),
      unwrap: 'data'
    })
  )
}

/** `slay hub users` — accounts on a hub. */
function hubUsersCommand(): Command {
  // Plural: `slay hub use` already exists, and a singular `user` would sit one
  // character from it in help output.
  const users = new Command('users')
    .description('Manage the accounts that can sign in to a hub')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  users
    .command('add <email>')
    .description('Create an account and print its generated password once')
    .option('--name <name>', 'Display name (default: the email local part)')
    .option('--json', 'Output as JSON')
    .action(async (email: string, opts: { name?: string; json?: boolean }) => {
      const created = await hubUsersRequest<HubUserRow & { password: string }>('POST', {
        email,
        ...(opts.name ? { name: opts.name } : {})
      })
      if (opts.json) {
        console.log(JSON.stringify({ email: created.email, password: created.password }, null, 2))
        return
      }
      console.log(`Created account: ${created.email}`)
      console.log(`Password:        ${created.password}`)
      console.log('')
      // Only the hash is stored, so this really is the one and only chance.
      console.log('This password is shown ONCE and cannot be recovered — save it now.')
      console.log('Sign in from the app: Settings → Hubs → Sign in.')
    })

  users
    .command('ls')
    .description('List the accounts on a hub')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const rows = await hubUsersRequest<HubUserRow[]>('GET')
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      if (rows.length === 0) {
        // An accountless remote hub is unusable, so name the fix rather than
        // printing a bare "none".
        console.log('No accounts yet. Create one with `slay hub users add <email>`.')
        return
      }
      const emailW = Math.max(5, ...rows.map((r) => r.email.length))
      const nameW = Math.max(4, ...rows.map((r) => r.name.length))
      console.log(`${'EMAIL'.padEnd(emailW)}  ${'NAME'.padEnd(nameW)}  CREATED`)
      console.log(`${'-'.repeat(emailW)}  ${'-'.repeat(nameW)}  ${'-'.repeat(10)}`)
      for (const r of rows) {
        const created = r.createdAt.slice(0, 10)
        console.log(`${r.email.padEnd(emailW)}  ${r.name.padEnd(nameW)}  ${created}`)
      }
    })

  users
    .command('rm <email>')
    .description('Remove an account and revoke its sessions')
    .action(async (email: string) => {
      // No confirmation prompt: the operator typed an exact email, the hub refuses
      // the two dangerous cases itself (last remaining account, runner service
      // identity), and an account is re-creatable with `add`.
      const removed = await hubUsersRequest<{ email: string }>('DELETE', {
        email
      })
      console.log(`Removed account: ${removed.email}`)
    })

  return users
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
    .option(
      '--public-address <host[:port]>',
      'Externally-reachable address of this hub — makes it a REMOTE hub (auth + TLS + wss join tokens)'
    )
    .option('--bind <host[:port]>', 'Address to bind (default: loopback, or 0.0.0.0 when remote)')
    .action(
      async (
        name: string,
        opts: {
          root?: string
          port?: string
          publicAddress?: string
          bind?: string
        }
      ) => {
        const root = resolvePath(opts.root ?? process.cwd())
        const port = opts.port === undefined ? undefined : Number(opts.port)
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
          fail(`Invalid --port ${opts.port} — expected an integer 1-65535.`)
        }

        // --- remote-hub setup ---------------------------------------------------
        //
        // WHY THIS EXISTS. Without a public address a hub boots in LOCAL mode, and
        // `deriveRunnerHubUrl` then embeds `ws://127.0.0.1:<port>/runners` in every
        // join token it mints. Minting still succeeds — so the failure is silent: a
        // runner on another machine dials its OWN loopback and never connects.
        // `--public-address` is what turns that into a usable deployment.
        //
        // Both values are bare AUTHORITIES (`host[:port]`, no scheme): the scheme
        // follows SLAYZONE_MODE, so carrying one here would let the two disagree.
        const publicAddress = opts.publicAddress?.trim()
        if (publicAddress !== undefined && !isBareAuthority(publicAddress)) {
          fail(
            `Invalid --public-address "${opts.publicAddress}" — expected host[:port] with no ` +
              `scheme and no path (e.g. hub.example.com:8443). The scheme is decided by the ` +
              `hub's mode, not by this value. IPv6 must be bracketed: [2001:db8::1]:8443`
          )
        }
        const bind = opts.bind?.trim()
        if (bind !== undefined && !isBareAuthority(bind)) {
          fail(
            `Invalid --bind "${opts.bind}" — expected host[:port] with no scheme and no path ` +
              `(e.g. 0.0.0.0:51100). IPv6 must be bracketed: [::]:51100`
          )
        }
        if (bind !== undefined && port !== undefined && parseHubAddress(bind)?.port !== port) {
          // Two different answers to "which port" is never what anyone means, and
          // whichever silently won would be a surprise.
          fail(
            `--bind ${bind} and --port ${port} disagree about the port. ` +
              `Give just one — \`--bind\` can carry the port itself.`
          )
        }
        // An explicit --bind always wins: `remote` + a loopback bind is a legitimate
        // and common shape (the hub sits behind a reverse proxy / tunnel that
        // terminates the public address), and assertModeHostConsistency permits it.
        // Only when the operator said nothing do we widen — a remote hub bound to
        // loopback with nothing in front of it would be unreachable.
        const address =
          bind ?? (publicAddress !== undefined ? (port ? `0.0.0.0:${port}` : '0.0.0.0') : undefined)

        const backend = resolveBackend()

        // A name identifies a hub for every other command, so it must be unique —
        // and "unique" has to include a hub that is REGISTERED BUT NOT RUNNING
        // (stopped, or crashed). Checking only running hubs would let `create`
        // silently overwrite an existing hub's unit.
        if (backend !== 'none' && existsSync(unitPath('hub', name, backend))) {
          const existingRoot = readUnitRoot('hub', name, backend)
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

        // Persist the deployment shape BEFORE launching, so the very first boot reads
        // it. `<ROOT>/hub.config.json` is the single channel for these (the unit carries
        // only the bind address) — a `mode` env var pinned in the unit would be a
        // second home for the same value that `hub restart --upgrade` then rewrites
        // away. Merges + 0600, so an existing config in this root keeps its keys.
        if (publicAddress !== undefined) {
          updateHubConfigFile(
            {
              mode: 'remote',
              publicAddress,
              ...(address !== undefined ? { address } : {})
            },
            join(root, 'hub.config.json')
          )
          console.log('Mode:   remote (client auth + TLS enforced)')
          console.log(`Bind:   ${address ?? '(hub block default)'}`)
          console.log(`Public: ${publicAddress}`)
          console.log(`Join tokens will point runners at wss://${publicAddress}/runners.`)
          // Printed BEFORE the boot wait, not after: remote mode enforces auth AND
          // closes public signup, so a hub with no account is permanently
          // unauthenticatable — and a first boot that fails (a missing cert chain, a
          // taken port) must not swallow the one step that makes the deployment
          // usable. The config is already on disk at this point, so the instruction
          // is valid whether or not the hub comes up.
          console.log('')
          console.log('This hub requires sign-in and public signup is closed, so create the')
          console.log('first account on THIS machine — there is no other way in:')
          console.log(`  slay hub users add <email> --hub ${name}`)
          console.log('Then, from another machine:')
          console.log(`  slay hub login https://${publicAddress} --email <email>`)
          console.log('')
        }

        await launchHub({
          name,
          root,
          port,
          ...(address !== undefined ? { address } : {}),
          backend,
          creating: true
        })

        if (publicAddress === undefined) {
          // Loopback is the RIGHT default (a personal hub, dev, the desktop app), so
          // this informs rather than warns. Silence, though, is how an operator mints a
          // token on a VPS, pastes it into a runner elsewhere, and gets no explanation
          // for why it never connects. Safe to print after the wait: a hub that failed
          // to boot has already exited non-zero with its own log excerpt.
          console.log('')
          console.log(
            `This hub is local-only: it binds loopback, so join tokens it mints point at\n` +
              `127.0.0.1 and only a runner on THIS machine can use them. For a hub other\n` +
              `machines dial, recreate it with \`--public-address <host:port>\`.`
          )
        }
      }
    )

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
        console.log(`Hub "${live.name}" is already running on port ${live.port} (pid ${live.pid}).`)
        return
      }
      if (backend === 'none') {
        fail(
          `This platform has no user service manager, so hubs are not registered ` +
            `and \`start\` has nothing to act on. Use \`slay hub create ${name}\`.`
        )
      }
      if (!existsSync(unitPath('hub', name, backend))) {
        fail(
          `No hub named "${name}". Create it with \`slay hub create ${name}\`, ` +
            `or list what exists with \`slay hub registered\`.`
        )
      }
      const root = readUnitRoot('hub', name, backend)
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
      const registered = backend !== 'none' && existsSync(unitPath('hub', hub.name, backend))
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
        if (backend !== 'none' && existsSync(unitPath('hub', nameOrPort, backend))) {
          const root = readUnitRoot('hub', nameOrPort, backend)
          supervisorStopQuiet('hub', backend, nameOrPort)
          removeUnit('hub', nameOrPort, backend)
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
      if (backend === 'none' || !existsSync(unitPath('hub', hub.name, backend))) {
        fail(
          `"${hub.name}" is not managed by slay, so it cannot be restarted from here. ` +
            `Stop it where it was started, then \`slay hub create ${hub.name}\`.`
        )
      }

      const { name, root } = hub
      const logDir = ensureLogDir('hub', root)
      // --upgrade re-resolves the package so the unit points at the new version;
      // without it the existing unit is reused verbatim.
      if (opts.upgrade) {
        const bin = resolveServiceBin('hub')
        writeUnit(
          {
            kind: 'hub',
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
      supervisorStop('hub', backend, name)
      await waitForHubGone(hub.port, 15_000)
      supervisorStart('hub', backend, name, unitPath('hub', name, backend))
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
      followServiceLog({
        kind: 'hub',
        name: hub.name,
        root: hub.root,
        lines,
        follow: opts.follow === true,
        systemdUnit: backend === 'systemd' && existsSync(unitPath('hub', hub.name, backend))
      })
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

  // slay hub login <url>
  //
  // `use --token` can only STORE a bearer somebody already had. On a hub that
  // enforces auth, every off-box command (`runner mint`, the whole REST surface)
  // needs one — so without this the only way to get a token was to read it out of
  // the desktop app's encrypted store by hand. This exchanges an account for one,
  // then stores it exactly as `use` does (0600 cli-hub-target.json).
  cmd
    .command('login <url>')
    .description('Sign in to a hub and store its bearer token for this CLI')
    .requiredOption('--email <email>', 'Account email (see `slay hub users ls`)')
    .option('--password <password>', 'Account password (omit to read from stdin)')
    .action(async (rawUrl: string, opts: { email: string; password?: string }) => {
      const url = normalizeHubUrl(rawUrl)
      if (!url) fail(`Invalid hub URL (expected an http(s) URL): ${rawUrl}`)
      // Prefer a piped password over an argv one: argv lands in the shell history
      // and in `ps` output. Named `--password` still exists for scripts that
      // already hold the secret in an env var.
      const password = opts.password ?? (await readPasswordFromStdin())
      if (!password) {
        fail(
          'No password given. Pass --password, or pipe it:\n' +
            `  echo '<password>' | slay hub login ${rawUrl} --email ${opts.email}`
        )
      }
      const token = await hubSignIn(url, opts.email, password)
      const configPath = writeHubConfig(url, token)
      console.log(`Signed in to ${url} as ${opts.email}.`)
      console.log(`Token stored: ${configPath}`)
      if (process.env.SLAYZONE_HUB_TOKEN) {
        console.error(
          'Note: SLAYZONE_HUB_TOKEN is set in the environment and takes precedence over this config.'
        )
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
      const units = listRegisteredUnits('hub', backend)
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
        const root = readUnitRoot('hub', u.name, backend)
        if (root) console.log(`  root: ${shortenPath(root)}`)
        if (!running) console.log(`  start: slay hub start ${u.name}`)
      }
    })

  // slay hub users add|ls|rm
  cmd.addCommand(hubUsersCommand())

  return cmd
}
