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
 * WHERE THE SECRETS GO. The join token is written to `<ROOT>/runner.config.json` (0600) and
 * never into the unit file (0644, world-readable). The runner's display name and
 * filesystem path-jail likewise have no env channel at all (see
 * `runner/src/config.ts`), so runner.config.json is the only channel for them too — the unit
 * pins `SLAYZONE_ROOT` and nothing else.
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync, rmSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { Command } from 'commander'
import { decodeJoinToken } from '@slayzone/platform/join-token'
import { isLoopbackRunnerUrl } from '@slayzone/platform/hub-addr'
import { discoverHubs } from '@slayzone/platform/hub-discovery'
import { hubRequest, resolveHubRequestTarget } from '../hub-request'
import {
  DEFAULT_LOCAL_RUNNER_NAME,
  loadRunnerConfigFile,
  updateRunnerConfigFile
} from '@slayzone/platform/slayzone-config'
import {
  detectBackendWithReason,
  explainNoBackend,
  listRegisteredUnits,
  readUnitRoot,
  removeUnit,
  unitPath,
  writeUnit,
  type ServiceBackend
} from '@slayzone/platform/service-unit'
import {
  configPathFor,
  isUnknown,
  listRunners,
  resolveRunner,
  type RunnerFacts
} from './runner-identity'
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

/**
 * Say so when a token's dial target names the hub's OWN machine.
 *
 * A hub in local mode embeds `ws://<loopback>:<port>/runners` in every token it
 * mints. That is correct for a co-located runner — the desktop app's auto-enrolled
 * one, or a `create` run on the hub box — and useless anywhere else: the runner
 * dials its own loopback and silently never connects.
 *
 * Deliberately a WARNING, not a failure, and phrased conditionally: this command
 * cannot know whether the operator is on the hub's machine, and the co-located case
 * is both legitimate and the common one. Failing would break it.
 */
function warnIfLoopbackHub(hubUrl: string): void {
  if (!isLoopbackRunnerUrl(hubUrl)) return
  console.log('')
  console.log(
    `Note: ${hubUrl} is a loopback address, so this token only works for a runner on the\n` +
      `hub's OWN machine. On any other machine it would dial that machine's loopback and\n` +
      `never connect. For a hub other machines can reach, recreate it with\n` +
      `\`slay hub create <name> --public-address <host:port>\`.`
  )
}

/**
 * Undo a partially-completed `create`.
 *
 * `create` writes config, then a unit, then starts — and any step can fail. Before
 * this, a failure after the config write left root state with no unit, which is the
 * split that made `create` ("already installed") and `start` ("not registered")
 * disagree permanently with no way out. Registered actions run on any failure path,
 * newest first, so the machine ends up as it started.
 */
const createRollback: Array<() => void> = []
function registerCreateRollback(undo: () => void): void {
  createRollback.push(undo)
}
export function runCreateRollback(): void {
  while (createRollback.length > 0) {
    try {
      createRollback.pop()?.()
    } catch {
      // Best-effort: a rollback step that throws must not mask the ORIGINAL failure,
      // which is the thing the operator needs to read.
    }
  }
}

/**
 * Resolve a runner the machine knows about in ANY way, or exit.
 *
 * Replaces the old unit-file-only lookup. Refusing on a missing unit while the root
 * still held a runner is what produced the unrecoverable state; the only honest
 * "does not exist" is no source knowing the name at all (see
 * {@link runnerIdentity.isUnknown}).
 */
async function requireKnown(name: string, backend: ServiceBackend): Promise<RunnerFacts> {
  const facts = await resolveRunner(name, backend)
  if (!isUnknown(facts)) return facts
  const { runners } = await listRunners(backend)
  const known = runners.map((r) => r.name)
  fail(
    `No runner named "${name}" on this machine.\n` +
      (known.length > 0
        ? `Known runners: ${known.join(', ')}`
        : 'No runners here. Create one with `slay runner create <name> --token <token>`.')
  )
}

/**
 * The root of a runner we are about to act on, or exit.
 *
 * A runner known ONLY to the hub (enrolled elsewhere, or its root deleted) has no
 * local root, so there is nothing here to start or read logs from. That is a real
 * state worth naming rather than crashing on a null path.
 */
function requireRoot(facts: RunnerFacts, verb: string): string {
  if (facts.root) return facts.root
  fail(
    `"${facts.name}" is enrolled on the hub but has no installation on this machine, ` +
      `so there is nothing to ${verb}.\n` +
      `Install it here with \`slay runner create ${facts.name} --token <token>\`, or ` +
      `run the command on the machine that hosts it.`
  )
}

/**
 * Resolve a registered runner's root, or exit with the standard not-found message.
 *
 * Still used where a UNIT is genuinely required (`restart` rewrites one). Everything
 * that can act on a partially-present runner uses {@link requireKnown} instead.
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
      // Same all-or-nothing rule as the supervised path: a first boot that never
      // reached a hub must not leave root state behind claiming this runner exists.
      if (creating) runCreateRollback()
      failWithLog(
        'runner',
        name,
        logs.out,
        `did not reach its hub within ${ENROLL_TIMEOUT_MS / 1000}s`
      )
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
    // never started — `ls` would list a runner that does not exist. The config
    // written earlier in this same `create` goes with it (runCreateRollback), or the
    // next `create` would meet an occupied root for a runner that never existed.
    if (creating) {
      removeUnit('runner', name, backend)
      runCreateRollback()
    }
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
      runCreateRollback()
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

  // slay runner mint [label] — ask a HUB for an enrollment token.
  //
  // The only verb here whose subject is a hub rather than this machine, and that is
  // unavoidable: a join token can only be minted by the hub it points at (it embeds
  // that hub's dial URL + cert fingerprint), so WHICH HUB A RUNNER CONNECTS TO is
  // decided here, not by `create`. It lives under `runner` because the thing being
  // created is a runner's credential; addressing follows the ambient hub target
  // (`--hub`, `SLAYZONE_HUB_ADDRESS`, `cli-hub-target.json`), so `slay --hub staging runner
  // mint` reads the same as every other hub-targeted command.
  cmd
    .command('mint [label]')
    .description('Mint a runner enrollment token on a hub (see `slay hub current`)')
    .option('--ttl <minutes>', 'Token lifetime in minutes', '15')
    .option('--json', 'Output as JSON')
    .action(async (label: string | undefined, opts: { ttl: string; json?: boolean }) => {
      const ttlMinutes = Number(opts.ttl)
      if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
        fail(`Invalid --ttl ${opts.ttl} — expected a positive number of minutes.`)
      }
      const target = await resolveHubRequestTarget('runner mint', discoverHubs)
      const minted = await hubRequest<{ token: string; hubUrl: string }>({
        target,
        path: '/api/runners/join-token',
        method: 'POST',
        body: {
          label: label ?? 'runner',
          ttlMs: Math.round(ttlMinutes * 60_000)
        },
        unwrap: 'raw',
        hints: {
          // The hub cannot know which command the operator should run to get a
          // credential, so name it here rather than leaving a bare 401.
          401:
            `Sign in to this hub first:\n` +
            `  slay hub login ${target.baseUrl} --email <email>\n` +
            `No account yet? Create one ON the hub machine: slay hub users add <email>`,
          403:
            `This hub only mints join tokens for callers on its own machine.\n` +
            `Run \`slay runner mint\` there, or put the hub in remote mode (` +
            `\`slay hub create --public-address <host:port>\`) so it can authenticate you.`
        }
      })

      if (opts.json) {
        console.log(JSON.stringify({ token: minted.token, hubUrl: minted.hubUrl }, null, 2))
        return
      }
      console.log(`Hub:   ${minted.hubUrl}`)
      console.log(`Token: ${minted.token}`)
      console.log('')
      console.log(`Expires in ${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'}, single use.`)
      console.log('Install a runner with it:')
      console.log(`  slay runner create ${label ?? '<name>'} --token ${minted.token}`)
      // Say this at the EARLIEST point a loopback token exists. Waiting until
      // `runner create` means the operator has already carried a dead token to
      // another machine before anything mentions it.
      warnIfLoopbackHub(minted.hubUrl)
    })

  // slay runner ls — every source that knows about a runner, unioned. See
  // runner-identity.ts for why the unit file could never be the registry on its own.
  cmd
    .command('ls')
    .description('List the runners this machine knows about')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const backend = resolveBackend()
      const { runners, hubReachable } = await listRunners(backend)
      if (opts.json) {
        console.log(JSON.stringify(runners, null, 2))
        return
      }
      if (runners.length === 0) {
        console.log('No runners here. Create one with `slay runner create <name> --token <token>`.')
        // Only mention supervision when it is actually missing — on a healthy box
        // this is noise, and the reason names the fix that applies to THIS machine.
        if (backend === 'none') console.log(`\n${explainNoBackend(detectBackendWithReason().reason)}`)
        return
      }
      const state = (r: RunnerFacts): string => {
        if (r.running) return 'running'
        if (r.supervised) return 'stopped'
        // Installed with no unit: a real runner the supervisor does not know about.
        // Naming it "stopped" would imply `start` merely resumes it, when `start`
        // actually has to register it first.
        return 'unmanaged'
      }
      const enrolled = (r: RunnerFacts): string =>
        !hubReachable && !r.enrolled ? '?' : r.enrolled ? 'yes' : 'no'
      const nameW = Math.max(4, ...runners.map((r) => r.name.length))
      const rootW = Math.max(4, ...runners.map((r) => (r.root ? shortenPath(r.root).length : 1)))
      const hubW = Math.max(3, ...runners.map((r) => (r.hubUrl ?? '-').length))
      console.log(
        `${'NAME'.padEnd(nameW)}  ${'STATE'.padEnd(9)}  ${'ROOT'.padEnd(rootW)}  ` +
          `${'HUB'.padEnd(hubW)}  ENROLLED`
      )
      console.log(
        `${'-'.repeat(nameW)}  ${'-'.repeat(9)}  ${'-'.repeat(rootW)}  ${'-'.repeat(hubW)}  ` +
          `${'-'.repeat(8)}`
      )
      for (const r of runners) {
        console.log(
          `${r.name.padEnd(nameW)}  ${state(r).padEnd(9)}  ` +
            `${(r.root ? shortenPath(r.root) : '?').padEnd(rootW)}  ` +
            `${(r.hubUrl ?? '-').padEnd(hubW)}  ${enrolled(r)}`
        )
      }
      if (!hubReachable) {
        console.log(
          `\nNo hub could be reached, so ENROLLED is unknown ("?") for runners this ` +
            `machine has no local record of.`
        )
      }
      const unmanaged = runners.filter((r) => state(r) === 'unmanaged')
      if (unmanaged.length > 0 && backend !== 'none') {
        console.log(
          `\n${unmanaged.map((r) => `"${r.name}"`).join(', ')} ${unmanaged.length === 1 ? 'is' : 'are'} ` +
            `installed but not registered with ${backend}. ` +
            `\`slay runner start <name>\` will register and start ${unmanaged.length === 1 ? 'it' : 'them'}.`
        )
      }
    })

  // slay runner create <name>
  cmd
    .command('create <name>')
    .description('Install a runner here and keep it running (crash-restart + start at login)')
    .requiredOption('--token <token>', 'Join token minted on the hub (szjt1.…)')
    .option('--root <dir>', 'Runner root — its config, credentials and logs (default: cwd)')
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
            `  slay runner mint ${name}\n` +
            `(or on this machine against a specific hub: \`slay --hub <name|port> runner mint ${name}\`)`
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
      // Two runners sharing a root would share `runner.config.json` (so the second's
      // token + name would overwrite the first's) and the credential store, then fight
      // over both. The unit check above cannot catch this: it is keyed on the NAME, so
      // a different name in an occupied root slips past it — and with no service
      // manager there is no unit to consult at all.
      //
      // ADOPT rather than refuse when the occupant IS this name. Reaching here means
      // no unit exists (the check above returned), so the root holds a runner the
      // supervisor does not know about — precisely what a `create` under a missing
      // supervisor leaves behind. There is one runner there, it has the name asked
      // for, and the operator asked to create it: refusing produced a state no
      // command could resolve. A DIFFERENT name in an occupied root is a genuine
      // conflict and still refuses.
      const occupant = loadRunnerConfigFile(configPathFor(root)).runnerName
      if (occupant !== undefined && occupant !== name) {
        fail(
          `A runner is already installed in ${shortenPath(root)} — "${occupant}".\n` +
            `Give this runner its own directory with \`--root <dir>\`, or remove ` +
            `"${occupant}" first with \`slay runner rm ${occupant}\`.`
        )
      }
      // ADOPT only when there is a supervisor to adopt INTO. Reaching here with the
      // same name means the root holds a runner with no unit — repairable by
      // registering it, which is exactly the wedge to undo.
      //
      // With NO supervisor there is nothing to register and, worse, no way to ask
      // whether that runner is currently RUNNING: an unsupervised runner is a bare
      // detached process this command cannot see. Adopting would spawn a second one
      // sharing the same runner.config.json and credential store, and the two would
      // fight over both. Refusing is correct there — the state is not repairable, so
      // say what is, rather than making it worse.
      const adopting = occupant === name && backend !== 'none'
      if (occupant === name && !adopting) {
        fail(
          `A runner is already installed in ${shortenPath(root)} — "${occupant}".\n` +
            `Start it with \`slay runner start ${name}\`, or remove it with ` +
            `\`slay runner rm ${name}\`.`
        )
      }
      if (adopting) {
        console.log(
          `Adopting the runner already in ${shortenPath(root)} — it is installed but not ` +
            `registered with ${backend}. Its config will be refreshed with this token.`
        )
        console.log(
          `  If you started it in the foreground, stop that process first — otherwise two ` +
            `runners would share this root.`
        )
      }

      // The token, hub url, display name and path-jail ALL travel via runner.config.json:
      // none has an env channel (by design — see runner/src/config.ts), and a 0644
      // unit file must never carry a credential. updateRunnerConfigFile writes 0600 and
      // merges, so an existing config in this root keeps its other keys.
      const allowedRoots =
        opts.allow && opts.allow.length > 0 ? opts.allow.map((d) => resolvePath(d)) : [root]
      updateRunnerConfigFile(
        {
          joinToken: opts.token,
          hubUrl: decoded.hubUrl,
          runnerName: name,
          allowedRoots
        },
        configPathFor(root)
      )
      // ALL OR NOTHING. Before this, a create that got past the config write but died
      // later (supervisor refused, enroll timed out) left root state with no unit —
      // the exact split that made `create` and `start` disagree forever. Unwind the
      // config we just wrote unless we are adopting one that predates this command.
      if (!adopting) {
        registerCreateRollback(() => {
          rmSync(configPathFor(root), { force: true })
        })
      }
      console.log(`Hub:   ${decoded.hubUrl}`)
      console.log(`Allow: ${allowedRoots.map((d) => shortenPath(d)).join(', ')}`)
      // Second warn site (the first is `mint`): a token can be carried here from
      // anywhere, including out of the desktop app's mint dialog, so this is the
      // last chance to say it before the enroll wait times out with no explanation.
      warnIfLoopbackHub(decoded.hubUrl)

      await launchRunner({ name, root, backend, creating: true })
    })

  // slay runner start <name>
  cmd
    .command('start <name>')
    .description('Start a runner, registering it first if it is not yet supervised')
    .action(async (name: string) => {
      const backend = resolveBackend()
      const facts = await requireKnown(name, backend)
      // ALREADY RUNNING is reported, not restarted: bouncing a live runner drops its
      // pty sessions and any agent turn in flight, which is not what someone typing
      // `start` wants. Use `restart`.
      if (facts.running) {
        const status = supervisorStatus('runner', backend, name)
        console.log(
          `Runner "${name}" is already running${status.pid ? ` (pid ${status.pid})` : ''}.`
        )
        return
      }
      const root = requireRoot(facts, 'start')
      // SELF-HEAL, don't refuse. Installed-but-unsupervised is the state a `create`
      // under a missing supervisor leaves behind — and until now `start` rejected it
      // as "no runner named X" while `create` rejected the same runner as "already
      // installed", which no command could resolve. `launchRunner` writes the unit
      // when it is absent, so simply proceeding IS the repair; say so, because
      // registering is a real side effect the operator did not explicitly ask for.
      if (!facts.supervised && backend !== 'none') {
        console.log(`"${name}" is installed but not registered with ${backend} — registering it.`)
      }
      await launchRunner({ name, root, backend, creating: false })
    })

  // slay runner stop <name>
  cmd
    .command('stop <name>')
    .description('Stop a runner, keeping it registered so `start` can bring it back')
    .action(async (name: string) => {
      const backend = resolveBackend()
      const facts = await requireKnown(name, backend)
      if (backend === 'none') return
      if (!facts.supervised) {
        console.log(
          `"${name}" is not registered with ${backend}, so there is nothing for it to stop.`
        )
        return
      }
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
    .option(
      '--purge',
      'Also delete the runner root (config, credentials, logs) — this is the operator’s data'
    )
    .action(async (name: string, opts: { purge?: boolean }) => {
      const backend = resolveBackend()
      const facts = await requireKnown(name, backend)
      // REMOVE WHATEVER EXISTS, in any combination. `rm` refusing on a missing unit
      // is what turned a half-created runner into a dead end — the operator could
      // neither create (root occupied) nor remove (not registered).
      if (facts.supervised && backend !== 'none') {
        // Quiet stop: the unit may be unloaded already, or the bus unreachable —
        // which is the very case that leaves a stale unit behind. Neither must block
        // removal.
        supervisorStopQuiet('runner', backend, name)
        removeUnit('runner', name, backend)
        console.log(`Unregistered "${name}" from ${backend}.`)
      } else if (backend !== 'none') {
        console.log(`"${name}" had no ${backend} registration.`)
      }

      if (facts.root && facts.installed) {
        if (opts.purge) {
          // Explicit only. The root holds the operator's credentials and logs, and
          // deleting it on a plain `rm` would destroy data they never offered up.
          rmSync(facts.root, { recursive: true, force: true })
          console.log(`Deleted ${shortenPath(facts.root)}.`)
        } else {
          // Leaving the config behind is safe now that `create` adopts an exact
          // name+root match — it no longer blocks a re-create the way it used to.
          console.log(`Config and credentials remain in ${shortenPath(facts.root)}.`)
          console.log(`  Delete them too with \`slay runner rm ${name} --purge\`.`)
        }
      }
      if (facts.enrolled) {
        console.log(
          `It is still enrolled on its hub — revoke it there if this machine is going away.`
        )
      }
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
    .action(async (name: string, opts: { lines: string; follow?: boolean }) => {
      const backend = resolveBackend()
      // Logs are the FIRST thing wanted when a runner misbehaves, so this must work
      // for an unsupervised one too — its output is in the root's log dir either way.
      const facts = await requireKnown(name, backend)
      const root = requireRoot(facts, 'read logs for')
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
