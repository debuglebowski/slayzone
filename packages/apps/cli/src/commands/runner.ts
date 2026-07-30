/**
 * `slay runner` — install and manage runners on THIS machine.
 *
 * A runner is an execution node: it dials OUT to a hub over a pinned `wss://` link
 * using a join token, then runs terminals/agents/git locally. `create` hands it to
 * the OS supervisor (launchd/systemd --user) so a crash or a logout doesn't silently
 * end it — the same guarantee `slay hub create` gives, with the same verbs.
 *
 * WHY THIS IS NOT A COPY OF `slay hub`. A hub BINDS a port and answers `/health`, so
 * `hub ls`/`stop`/`--hub` all work by probing the hub port block — identity comes off
 * the wire. A runner binds nothing. There is no port to probe and no `/health` to ask,
 * so a runner's machine-side identity is its UNIT FILE, and "is it up" is a question
 * only the supervisor that owns it can answer (`supervisorStatus`). That is why:
 *   - every command addresses a runner by NAME only (never a port);
 *   - `ls` enumerates unit files rather than sweeping ports, which also makes it the
 *     `hub registered` equivalent — a runner that installed but never enrolled shows
 *     up, which is precisely the invisible-crash-loop case worth surfacing;
 *   - `stop` cannot "confirm the port closed"; it confirms with the supervisor.
 *
 * WHERE THE SECRETS GO. The join token is written to `<ROOT>/config.json` (0600) and
 * never into the unit file (0644, world-readable). The runner's display name and
 * filesystem path-jail likewise have no env channel at all (see
 * `runner/src/config.ts`), so config.json is the only channel for them too — the unit
 * pins `SLAYZONE_ROOT` and nothing else.
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync, readdirSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { Command } from 'commander'
import { decodeJoinToken } from '@slayzone/platform/join-token'
import {
  DEFAULT_LOCAL_RUNNER_NAME,
  loadSlayzoneConfig,
  updateSlayzoneConfig
} from '@slayzone/platform/slayzone-config'
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
  ensureLogDir,
  fail,
  failWithLog,
  followServiceLog,
  readServiceLogTail,
  resolveBackend,
  resolveServiceBin,
  serviceLogPaths,
  servicePackage,
  shortenPath,
  SupervisorError,
  supervisorStart,
  supervisorStatus,
  supervisorStop,
  supervisorStopQuiet
} from '../service'

const RUNNER_PACKAGE = servicePackage('runner')

/** How long to wait for a fresh runner to reach the hub before giving up. */
const ENROLL_TIMEOUT_MS = 30_000

/**
 * The runner's own log line proving it reached the hub.
 *
 * `main.ts` logs `connected to hub {"runnerId":…,"mode":"enroll"|"hello"}` from the
 * dialer's `connected` event: `enroll` on first contact (the join token was accepted
 * and credentials were minted), `hello` when it reconnected with stored credentials.
 * Either one means the link is live, which is the only success signal a runner has —
 * unlike a hub, there is no port to probe. `publish-npm.sh` asserts on the same line.
 */
const CONNECTED_RE = /"mode":"(enroll|hello)"/

/** `<ROOT>/config.json` for a runner rooted at `root`. */
function configPathFor(root: string): string {
  return join(root, 'config.json')
}

/**
 * Whether this runner holds credentials for a hub — i.e. it has enrolled at least
 * once. The dialer writes `<ROOT>/runners/<hub-host>.json` (0600) after a successful
 * enroll, so the presence of any file there is the durable record.
 *
 * This is what separates "installed but never reached its hub" (a bad token, an
 * unreachable hub, a crash-looping unit) from "running normally, currently offline".
 */
function isEnrolled(root: string): boolean {
  try {
    return readdirSync(join(root, 'runners')).some((f) => f.endsWith('.json'))
  } catch {
    return false
  }
}

/**
 * Resolve a registered runner's root, or exit with the standard not-found message.
 *
 * Every command but `create` needs this and needs it worded identically. A runner
 * with no unit simply does not exist as far as this machine is concerned — there is
 * no "running but unregistered" runner to fall back on, since nothing on the box
 * would know about it.
 */
function requireRegistered(name: string, backend: ServiceBackend): { root: string } {
  if (backend === 'none') {
    fail(
      `This platform has no user service manager, so runners cannot be registered ` +
        `here. Run one in the foreground instead:\n  npx ${RUNNER_PACKAGE}`
    )
  }
  if (!existsSync(unitPath('runner', name, backend))) {
    const known = listRegisteredUnits('runner', backend).map((u) => u.name)
    fail(
      `No runner named "${name}" on this machine.\n` +
        (known.length > 0
          ? `Registered runners: ${known.join(', ')}`
          : 'No runners are registered. Create one with `slay runner create <name> --token <token>`.')
    )
  }
  const root = readUnitRoot('runner', name, backend)
  if (!root) {
    fail(
      `The unit for "${name}" does not record a root — it may be hand-edited. ` +
        `Remove it with \`slay runner rm ${name}\` and create it again.`
    )
  }
  return { root }
}

/** Poll the runner's captured output until it reports a live hub link. */
async function waitForConnected(root: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (CONNECTED_RE.test(readServiceLogTail('runner', root, 200))) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 300))
  }
}

/**
 * Bring a runner up: resolve its binary, write/refresh its unit, hand it to the
 * supervisor, and wait until it reports a live hub link.
 *
 * Shared by `create` (first time) and `start` (an existing, stopped runner) so the
 * two cannot drift on the parts that must match — the interpreter pairing, the log
 * directory, the failure reporting. `creating` only affects wording and whether a
 * failed boot rolls the registration back.
 */
async function launchRunner(args: {
  name: string
  root: string
  backend: ServiceBackend
  creating: boolean
}): Promise<void> {
  const { name, root, backend, creating } = args
  const bin = resolveServiceBin('runner')
  const logDir = ensureLogDir('runner', root)
  const logs = serviceLogPaths('runner', root)

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
        // A detached runner has no TTY, but be explicit: the first-run prompt must
        // never block a spawn nobody is watching.
        SLAYZONE_NONINTERACTIVE: '1',
        // Same interpreter requirement as the unit path: a dev-tree runner needs
        // ELECTRON_RUN_AS_NODE or its Electron-ABI natives fail to load.
        ...(bin.env ?? {})
      }
    })
    child.unref()
    if (!(await waitForConnected(root, ENROLL_TIMEOUT_MS))) {
      failWithLog('runner', name, logs.out, `did not reach its hub within ${ENROLL_TIMEOUT_MS / 1000}s`)
    }
    console.log(`Runner "${name}" started (pid ${child.pid ?? '?'}) and reached its hub.`)
    console.log(`  Root:  ${shortenPath(root)}`)
    console.log(`  Logs:  ${shortenPath(logDir)}`)
    console.log(
      'Note: this platform has no user service manager, so the runner will NOT restart ' +
        'if it crashes, and will not come back after a reboot.'
    )
    return
  }

  const writtenUnitPath = writeUnit(
    {
      kind: 'runner',
      name,
      root,
      command: bin.command,
      args: bin.args,
      logDir,
      ...(bin.env ? { env: bin.env } : {})
    },
    backend
  )
  // Say what is happening BEFORE the wait: registration is a real side effect, and
  // the wait can take seconds. Silence here reads as "nothing happened" while the
  // supervisor may already be crash-looping the runner.
  if (creating) console.log(`Registered ${writtenUnitPath}`)
  console.log(`Starting runner "${name}" (${RUNNER_PACKAGE}@${bin.version})…`)
  try {
    supervisorStart('runner', backend, name, writtenUnitPath)
  } catch (e) {
    // The supervisor refused. Never leave a unit file behind for a runner that was
    // never started — `ls` would list a runner that does not exist.
    if (creating) removeUnit('runner', name, backend)
    if (!(e instanceof SupervisorError)) throw e
    // A systemd USER manager needs a login session bus. On a VPS/container there
    // often is none, and every `--user` call fails this way. Name the actual fix
    // rather than echoing "Command failed".
    const noBus = /Failed to connect to bus|No medium found/i.test(e.output)
    fail(
      `Could not register runner "${name}" with ${backend}.\n\n` +
        `  ${e.command}\n  ${e.output || '(no output)'}\n\n` +
        (noBus
          ? `systemd has no user session bus for this account, so \`systemctl --user\` ` +
            `cannot work. Enable a persistent user manager:\n` +
            `  sudo loginctl enable-linger ${process.env.USER ?? '<user>'}\n` +
            `then log out and back in, and retry. If this account is not meant to have ` +
            `one (a container, or a root-only box), run the runner under the system ` +
            `manager or in the foreground instead:\n` +
            `  npx ${RUNNER_PACKAGE}\n`
          : '')
    )
  }

  // WAIT FOR ENROLLMENT, not merely for a live process. A runner with a bad token
  // starts fine, fails auth, and exits non-zero — which the supervisor then retries
  // forever. Reporting success on "the process exists" would hand the operator a
  // runner that never does any work.
  if (!(await waitForConnected(root, ENROLL_TIMEOUT_MS))) {
    if (creating) {
      // A failed FIRST boot must not leave a registered, crash-looping unit behind:
      // the supervisor would retry it forever, invisibly, and the operator was given
      // no working runner. An existing runner's unit is left alone — the operator may
      // want to fix its config and `start` again.
      supervisorStop('runner', backend, name)
      removeUnit('runner', name, backend)
    } else {
      supervisorStop('runner', backend, name)
    }
    failWithLog(
      'runner',
      name,
      logs.err,
      creating
        ? `did not reach its hub within ${ENROLL_TIMEOUT_MS / 1000}s, so it was unregistered again`
        : `did not reach its hub within ${ENROLL_TIMEOUT_MS / 1000}s (its registration was left in place)`
    )
  }

  const status = supervisorStatus('runner', backend, name)
  console.log(
    `Runner "${name}" running${status.pid ? ` (pid ${status.pid})` : ''} and connected to its hub.`
  )
  console.log(`  Root:  ${shortenPath(root)}`)
  console.log(`  Logs:  ${shortenPath(logDir)}`)
  console.log(`  Unit:  ${writtenUnitPath}`)
  console.log(`  Runner: ${RUNNER_PACKAGE}@${bin.version}`)
  // State exactly what the supervisor guarantees. A user agent starts at LOGIN, not
  // at boot — claiming "survives reboot" would be wrong.
  console.log('Restarts automatically if it crashes, and starts again when you log in.')
}

/** Wait for the supervisor to report the job gone, so `stop` confirms rather than assumes. */
async function waitForStopped(
  name: string,
  backend: Exclude<ServiceBackend, 'none'>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!supervisorStatus('runner', backend, name).running) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

export function runnerCommand(): Command {
  const cmd = new Command('runner')
    .description('Run and manage SlayZone runners on this machine')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay runner ls — unit files + supervisor state. This is also the `hub
  // registered` equivalent: with no port to sweep, enumeration IS the listing.
  cmd
    .command('ls')
    .description('List the runners installed on this machine')
    .option('--json', 'Output as JSON')
    .action((opts: { json?: boolean }) => {
      const backend = detectBackend()
      if (backend === 'none') {
        console.log('This platform has no user service manager — no runners can be registered.')
        return
      }
      const units = listRegisteredUnits('runner', backend)
      const rows = units.map((u) => {
        const root = readUnitRoot('runner', u.name, backend)
        const status = supervisorStatus('runner', backend, u.name)
        // hubUrl comes from the runner's own config.json — the unit deliberately
        // carries no hub address (a runner's dial target arrives with its token).
        const hubUrl = root ? (loadSlayzoneConfig(configPathFor(root)).hubUrl ?? null) : null
        return {
          name: u.name,
          unitPath: u.unitPath,
          root,
          running: status.running,
          pid: status.pid,
          lastExit: status.lastExit,
          hubUrl,
          enrolled: root ? isEnrolled(root) : false
        }
      })
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      if (rows.length === 0) {
        console.log(
          'No runners installed. Create one with `slay runner create <name> --token <token>`.'
        )
        return
      }
      const nameW = Math.max(4, ...rows.map((r) => r.name.length))
      const rootW = Math.max(4, ...rows.map((r) => (r.root ? shortenPath(r.root).length : 1)))
      const hubW = Math.max(3, ...rows.map((r) => (r.hubUrl ?? '-').length))
      console.log(
        `${'NAME'.padEnd(nameW)}  ${'STATE'.padEnd(7)}  ${'PID'.padEnd(7)}  ` +
          `${'ROOT'.padEnd(rootW)}  ${'HUB'.padEnd(hubW)}  ENROLLED`
      )
      console.log(
        `${'-'.repeat(nameW)}  ${'-'.repeat(7)}  ${'-'.repeat(7)}  ${'-'.repeat(rootW)}  ` +
          `${'-'.repeat(hubW)}  ${'-'.repeat(8)}`
      )
      for (const r of rows) {
        console.log(
          `${r.name.padEnd(nameW)}  ${(r.running ? 'running' : 'stopped').padEnd(7)}  ` +
            `${String(r.pid ?? '-').padEnd(7)}  ${(r.root ? shortenPath(r.root) : '?').padEnd(rootW)}  ` +
            `${(r.hubUrl ?? '-').padEnd(hubW)}  ${r.enrolled ? 'yes' : 'no'}`
        )
      }
      // A runner that is registered but never enrolled is the runner equivalent of a
      // hub that installed and crash-looped: it looks installed and does nothing.
      for (const r of rows.filter((x) => !x.enrolled)) {
        console.log(
          `\nRunner "${r.name}" has never reached a hub` +
            (r.lastExit !== null && r.lastExit !== 0 ? ` (last exit ${r.lastExit})` : '') +
            `. Check \`slay runner logs ${r.name}\`.`
        )
      }
      for (const r of rows.filter((x) => !x.running)) {
        console.log(`\nRunner "${r.name}" is stopped. Start it: slay runner start ${r.name}`)
      }
    })

  // slay runner create <name>
  cmd
    .command('create <name>')
    .description('Install a runner here and keep it running (crash-restart + start at login)')
    .requiredOption('--token <token>', 'Join token minted on the hub (szjt1.…)')
    .option('--root <dir>', "Runner root — its config, credentials and logs (default: cwd)")
    .option(
      '--allow <dir>',
      'Filesystem root the runner may operate under (repeatable; default: the runner root)',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .action(async (name: string, opts: { token: string; root?: string; allow?: string[] }) => {
      const root = resolvePath(opts.root ?? process.cwd())
      const backend = resolveBackend()

      // VALIDATE THE TOKEN LOCALLY FIRST. A malformed token would otherwise install a
      // unit whose runner can never dial anywhere, and the supervisor would retry it
      // forever. The token embeds the hub url + cert fingerprint, so decoding it also
      // tells us (and `ls`) which hub this runner belongs to.
      const decoded = decodeJoinToken(opts.token)
      if (!decoded) {
        fail(
          `--token is not a valid SlayZone join token (expected \`szjt1.<payload>\`).\n` +
            `Mint one on the hub:\n` +
            `  curl -X POST http://127.0.0.1:<hub-port>/api/runners/join-token \\\n` +
            `    -H 'content-type: application/json' -d '{"label":"${name}"}'`
        )
      }

      // `local-runner` is the desktop app's co-located runner, and the hub COLLAPSES
      // every enroll under that name onto one deterministic id (see
      // DEFAULT_LOCAL_RUNNER_NAME). A second runner claiming it would silently take
      // over that row instead of appearing as its own node.
      if (name === DEFAULT_LOCAL_RUNNER_NAME) {
        fail(
          `"${DEFAULT_LOCAL_RUNNER_NAME}" is reserved for the runner inside the SlayZone ` +
            `desktop app — a second runner using it would collide with that one on the hub. ` +
            `Choose another name.`
        )
      }

      // A name identifies a runner for every other command, so it must be unique —
      // including a runner that is REGISTERED BUT NOT RUNNING (stopped, or crashed).
      if (backend !== 'none' && existsSync(unitPath('runner', name, backend))) {
        const existingRoot = readUnitRoot('runner', name, backend)
        fail(
          `A runner named "${name}" already exists${
            existingRoot ? ` (root ${shortenPath(existingRoot)})` : ''
          }.\n` +
            `Start it with \`slay runner start ${name}\`, or remove it with ` +
            `\`slay runner rm ${name}\`.`
        )
      }

      // ONE ROOT, ONE RUNNER — checked independently of the unit file.
      //
      // Two runners sharing a root would share `config.json` (so the second's token +
      // name would overwrite the first's) and the `runners/` credential store, then
      // fight over both. The unit check above cannot catch this: it is keyed on the
      // NAME, so a different name in an occupied root slips past it — and on a
      // platform with no service manager there is no unit to consult at all, which is
      // how a second `create` came to silently spawn a rival runner. `config.json`
      // already naming a runner is the durable record that this root is taken.
      const occupant = loadSlayzoneConfig(configPathFor(root)).runnerName
      if (occupant !== undefined) {
        fail(
          `A runner is already installed in ${shortenPath(root)} — "${occupant}".\n` +
            (occupant === name
              ? `Start it with \`slay runner start ${name}\`, or remove it with ` +
                `\`slay runner rm ${name}\`.`
              : `Give this runner its own directory with \`--root <dir>\`, or remove ` +
                `"${occupant}" first with \`slay runner rm ${occupant}\`.`)
        )
      }

      // The token, hub url, display name and path-jail ALL travel via config.json:
      // none has an env channel (by design — see runner/src/config.ts), and a 0644
      // unit file must never carry a credential. updateSlayzoneConfig writes 0600 and
      // merges, so an existing config in this root keeps its other keys.
      const allowedRoots = opts.allow && opts.allow.length > 0 ? opts.allow.map((d) => resolvePath(d)) : [root]
      updateSlayzoneConfig(
        {
          joinToken: opts.token,
          hubUrl: decoded.hubUrl,
          runnerName: name,
          allowedRoots
        },
        configPathFor(root)
      )
      console.log(`Hub:   ${decoded.hubUrl}`)
      console.log(`Allow: ${allowedRoots.map((d) => shortenPath(d)).join(', ')}`)

      await launchRunner({ name, root, backend, creating: true })
    })

  // slay runner start <name>
  cmd
    .command('start <name>')
    .description('Start an existing runner that is stopped')
    .action(async (name: string) => {
      const backend = resolveBackend()
      const { root } = requireRegistered(name, backend)
      // ALREADY RUNNING is reported, not restarted: bouncing a live runner drops its
      // pty sessions and any agent turn in flight, which is not what someone typing
      // `start` wants. Use `restart`.
      if (backend !== 'none' && supervisorStatus('runner', backend, name).running) {
        const status = supervisorStatus('runner', backend, name)
        console.log(
          `Runner "${name}" is already running${status.pid ? ` (pid ${status.pid})` : ''}.`
        )
        return
      }
      await launchRunner({ name, root, backend, creating: false })
    })

  // slay runner stop <name>
  cmd
    .command('stop <name>')
    .description('Stop a runner, keeping it registered so `start` can bring it back')
    .action(async (name: string) => {
      const backend = resolveBackend()
      requireRegistered(name, backend)
      if (backend === 'none') return
      supervisorStop('runner', backend, name)
      if (!(await waitForStopped(name, backend, 15_000))) {
        fail(
          `Runner "${name}" is still running after 15s according to ${backend}. ` +
            `It may be managed elsewhere (docker, a system unit).`
        )
      }
      console.log(`Stopped "${name}". Start it again with \`slay runner start ${name}\`.`)
    })

  // slay runner rm <name>
  cmd
    .command('rm <name>')
    .description('Stop a runner and remove its registration')
    .action((name: string) => {
      const backend = resolveBackend()
      const { root } = requireRegistered(name, backend)
      if (backend === 'none') return
      // Quiet stop: the unit may be unloaded already, or the bus unreachable — which
      // is the very case that leaves a stale unit behind. Neither must block removal.
      supervisorStopQuiet('runner', backend, name)
      removeUnit('runner', name, backend)
      // The runner's ROOT (config.json with its token, credentials, logs) is
      // deliberately left on disk: it is the operator's data, and `rm` was asked to
      // remove a registration, not to delete their state. NOTE this does not revoke
      // the runner on the HUB — it will show there as disconnected until revoked.
      console.log(`Removed "${name}". Its config and credentials are still in ${shortenPath(root)}.`)
      console.log(
        `It is still enrolled on its hub — revoke it there if this machine is going away.`
      )
    })

  // slay runner restart <name>
  cmd
    .command('restart <name>')
    .description('Restart a runner')
    .option('--upgrade', `Re-resolve ${RUNNER_PACKAGE} first (picks up a newer version)`)
    .action(async (name: string, opts: { upgrade?: boolean }) => {
      const backend = resolveBackend()
      const { root } = requireRegistered(name, backend)
      if (backend === 'none') return
      const logDir = ensureLogDir('runner', root)
      // --upgrade re-resolves the package so the unit points at the new version;
      // without it the existing unit is reused verbatim.
      if (opts.upgrade) {
        const bin = resolveServiceBin('runner')
        writeUnit(
          {
            kind: 'runner',
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
        console.log(`Unit updated to ${RUNNER_PACKAGE}@${bin.version}.`)
      }
      supervisorStop('runner', backend, name)
      await waitForStopped(name, backend, 15_000)
      supervisorStart('runner', backend, name, unitPath('runner', name, backend))
      if (!(await waitForConnected(root, ENROLL_TIMEOUT_MS))) {
        fail(
          `Runner "${name}" did not reconnect within ${ENROLL_TIMEOUT_MS / 1000}s. ` +
            `Check \`slay runner logs ${name}\`.`
        )
      }
      const status = supervisorStatus('runner', backend, name)
      console.log(
        `Runner "${name}" restarted${status.pid ? ` (pid ${status.pid})` : ''} and reconnected.`
      )
    })

  // slay runner logs <name>
  cmd
    .command('logs <name>')
    .description("Show a runner's log output")
    .option('-n, --lines <n>', 'Last N lines', '50')
    .option('-f, --follow', 'Follow the log')
    .action((name: string, opts: { lines: string; follow?: boolean }) => {
      const backend = detectBackend()
      const { root } = requireRegistered(name, backend)
      const lines = Number(opts.lines)
      if (!Number.isInteger(lines) || lines < 1) fail(`Invalid --lines ${opts.lines}.`)
      // systemd captures stdout into journald rather than a file, so the unit's own
      // output is only readable there.
      followServiceLog({
        kind: 'runner',
        name,
        root,
        lines,
        follow: opts.follow === true,
        systemdUnit: backend === 'systemd' && existsSync(unitPath('runner', name, backend))
      })
    })

  return cmd
}
