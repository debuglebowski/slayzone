/**
 * slayzone-computer CLI entrypoint.
 *
 *   SLAYZONE_HUB_ADDRESS=hub:8443 \
 *   SLAYZONE_HUB_JOIN_TOKEN=... \
 *   slayzone-computer
 *
 * SLAYZONE_HUB_ADDRESS carries the hub AUTHORITY only (host[:port]); the dial
 * scheme (ws/wss) is derived from the host (loopback → ws, else wss), and
 * `/computers` is appended.
 *
 * On an interactive terminal a fresh computer (no join token AND no stored
 * credentials) is prompted for its join token + path-jail + name, then offered
 * to persist them to <ROOT>/computer.config.json — see `maybeInteractiveSetup`. Piped /
 * supervised / SLAYZONE_NONINTERACTIVE runs skip that and behave exactly as
 * before (fail-fast usage error when the token is missing).
 *
 * See `config.ts` for the full set of SLAYZONE_* variables and the
 * <ROOT>/computer.config.json file.
 */

import type { ComputerBootSeed } from './config'
import { hostname } from 'node:os'
import { probeNativeTerminal } from './native-probe'
import { delimiter } from 'node:path'
import { canPrompt, runInteractiveConfig } from '@slayzone/platform/config-prompt'
import {
  getComputerConfigFilePath,
  readComputerConfigSnapshot
} from '@slayzone/platform/slayzone-config'
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import { SUPERVISED_STOP_DEADLINE_MS, watchParent } from '@slayzone/platform/parent-watch'
import { createFileCredentialStore, hubHostFromUrl } from '@slayzone/computer-transport/client'
import {
  ENV_VARS,
  effectiveHubUrls,
  ignoredCertPinNotices,
  loadBootComputerConfig,
  supervisedComputerConfigFile
} from './config'
import { adoptLoginShellPath } from './login-shell-path'
import { COMPUTER_VERSION, startComputer, watchPrimaryHubExitCode } from './main'
import { createSupervisorIpc } from './supervisor-ipc'
import { isUpgradeWorker, receiveUpgradeBoot, superviseUpgrades } from './upgrade-runtime'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fork } from 'node:child_process'
import { ensureComputerLauncher } from '@slayzone/platform/computer-launcher'
import { atomicRuntimeJson, startSessionHost } from './session-host'
import { startConnector } from './connector'
import {
  HOST_CONTRACT_VERSION,
  HOST_MAINTENANCE_MIN_CONTRACT_VERSION
} from '@slayzone/computer-runtime'
import { COMPUTER_BUILD_ID } from './build-identity'

/**
 * First-run interactive setup for a STANDALONE computer. Runs ONLY when
 * {@link canPrompt} and the computer has no usable way to reach a hub yet:
 *   - no join token (env / computer.config.json), AND
 *   - no stored credentials for an already-known hub URL.
 * In every other case (token present, already enrolled, non-interactive) this
 * is a no-op and the boot is byte-identical to before.
 *
 * Prompts the join token (embeds hub URL + cert pin), the filesystem path-jail
 * (default: the launch dir), and an optional display name (default: hostname —
 * left unset unless the user types a custom one, so it resolves live). On a
 * `[Y/n]`-confirm the values persist to <ROOT>/computer.config.json so later boots
 * need no prompt. The join token is also seeded into `process.env` (the resolver
 * reads it via ENV_VARS.joinToken); the name + path-jail have NO env channel, so
 * this returns them to `main` to layer over the config even on a declined save.
 */
async function maybeInteractiveSetup(): Promise<{
  name?: string
  allowedRoots?: string[]
  unsaved?: boolean
}> {
  if (!canPrompt()) return {}

  const cfg = readComputerConfigSnapshot().config
  // A join token is self-sufficient (first contact) → nothing to ask.
  if ((process.env[ENV_VARS.joinToken] ?? cfg.joinToken) !== undefined) return {}

  // Already enrolled? A stored credential for the known hub host means we can
  // reconnect without a token. Skip the prompt in that case. The env channel
  // carries authority only, so compose it into a url (scheme from the host) before
  // deriving the credential-store host key; computer.config.json still carries a full url.
  const envAddress = process.env[ENV_VARS.hubAddress]
  const hubUrl =
    envAddress !== undefined ? hubUrlFromAddr(envAddress, 'ws', '/computers') : cfg.hubUrl
  if (hubUrl !== undefined) {
    try {
      // Creds derive from the ROOT anchor (`<ROOT>/computer.state.json`) — no override knob.
      const store = createFileCredentialStore(hubHostFromUrl(hubUrl))
      if (await store.load()) return {}
    } catch {
      // Unreadable url/creds → fall through to prompting.
    }
  }

  const defaultRoot = process.env.SLAYZONE_ROOT ?? process.cwd()
  const result = await runInteractiveConfig({
    title: 'Computer setup — values to save to computer.config.json:',
    configPath: getComputerConfigFilePath(),
    fields: [
      {
        configKey: 'joinToken',
        envKey: ENV_VARS.joinToken,
        label: 'Hub join token (from `POST /api/computers/join-token` on the hub)'
      },
      {
        // envKey is inert — the resolver has no env channel for the path-jail
        // (like `computerName` below). A saved value reaches computer.config.json (re-read
        // below); a declined-save value is threaded into loadComputerConfig via the
        // returned allowedRoots.
        configKey: 'allowedRoots',
        envKey: 'SLAYZONE_COMPUTER_ALLOWED_ROOTS',
        label: 'Filesystem roots the computer may access (comma-separated)',
        default: defaultRoot,
        transform: (raw) => {
          const roots = raw
            .split(',')
            .map((r) => r.trim())
            .filter((r) => r.length > 0)
          return roots.length > 0 ? { config: roots, env: roots.join(delimiter) } : null
        }
      },
      {
        // No default → an empty answer is SKIPPED (not persisted), so the computer
        // name resolves to the live hostname each boot instead of a pinned value.
        // envKey is inert here — the resolver has no env channel for the name; a
        // saved value reaches computer.config.json (re-read below), a declined-save value
        // is threaded into loadComputerConfig via the returned name.
        configKey: 'computerName',
        envKey: 'SLAYZONE_COMPUTER_NAME',
        label: 'Computer display name',
        hint: `default: ${hostname()}`
      }
    ]
  })

  // Return the prompted name + path-jail (saved or this-run-only) so main can
  // layer them over the shared config even when the user declines persisting.
  const collectedName = result.collected.find((c) => c.field.configKey === 'computerName')
  const collectedRoots = result.collected.find((c) => c.field.configKey === 'allowedRoots')
  const out: { name?: string; allowedRoots?: string[]; unsaved?: boolean } = {
    unsaved: !result.saved
  }
  if (typeof collectedName?.config === 'string') out.name = collectedName.config
  if (Array.isArray(collectedRoots?.config)) out.allowedRoots = collectedRoots.config as string[]
  return out
}

async function main(): Promise<void> {
  if (process.argv.includes('--runtime-contract')) {
    process.stdout.write(
      JSON.stringify({
        // Old supervisors understand only min/max. This connector can bridge
        // v1/v2 safely for stops, while fullChatMin tells new supervisors to
        // replace a host which lacks current chat ownership preconditions.
        min: HOST_MAINTENANCE_MIN_CONTRACT_VERSION,
        max: HOST_CONTRACT_VERSION,
        fullChatMin: HOST_CONTRACT_VERSION,
        maintenanceMin: HOST_MAINTENANCE_MIN_CONTRACT_VERSION,
        buildId: COMPUTER_BUILD_ID,
        version: COMPUTER_VERSION
      }) + '\n'
    )
    return
  }
  if (process.argv.includes('--upgrade-probe')) {
    await probeNativeTerminal((stage) => process.stderr.write(`[computer-probe] ${stage}\n`))
    // node-pty's ConPTY reader worker can outlive a successfully exited child.
    // This is a one-shot probe with no other work: flush its result, then exit
    // explicitly so install validation cannot hang on the native reader.
    process.stdout.write(COMPUTER_VERSION + '\n', () => process.exit(0))
    return
  }
  if (process.argv.includes('--session-host')) {
    const root = process.env.SLAYZONE_ROOT ?? process.cwd()
    let seed: Record<string, unknown> = {}
    try {
      seed = JSON.parse(readFileSync(join(root, 'computer-runtime', 'host-config.json'), 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const config = loadBootComputerConfig(seed)
    if (!config.allowedRoots.length) config.allowedRoots = [root]
    const host = await startSessionHost(root, config, (message, meta) =>
      process.stdout.write(`[host] ${message} ${JSON.stringify(meta ?? {})}\n`)
    )
    process.send?.({ type: 'supervisor-ready' }, () => undefined)
    void host.closed.then(() => {
      if (process.connected) process.disconnect()
    })
    process.on('SIGINT', () => void host.stop())
    process.on('SIGTERM', () => void host.stop())
    return
  }
  const workerBoot = isUpgradeWorker() ? await receiveUpgradeBoot() : undefined
  // Started by the desktop app (local-computer-supervisor.ts), which owns this
  // computer's env, root and lifetime.
  const supervised = process.env.SLAYZONE_SUPERVISED === '1'

  // ROOT anchoring (standalone only): a bare `slayzone-computer` anchors its
  // computer.config.json + credential store to the launch dir. Seed BEFORE loadComputerConfig
  // (which reads <ROOT>/computer.config.json via getSlayzoneHomeDir). Skipped when
  // supervised — the Electron host supplies the computer's env in full. Operator
  // env still wins (explicit SLAYZONE_ROOT respected).
  if (!supervised && !process.env.SLAYZONE_ROOT) {
    process.env.SLAYZONE_ROOT = process.cwd()
  }

  // Interactive first-run setup (TTY only) — may seed the join token into env +
  // write computer.config.json before the resolver below reads them. No-op when
  // non-interactive / enrolled. Returns the prompted display name + path-jail (if
  // any) so a declined-save still applies them this boot (neither has an env
  // channel).
  const prompted = workerBoot ? {} : await maybeInteractiveSetup()

  let config
  let bootSeed: ComputerBootSeed = {}
  try {
    const savedSeed: ComputerBootSeed | undefined =
      !workerBoot && !supervised
        ? (() => {
            try {
              return JSON.parse(
                readFileSync(
                  join(
                    dirname(getComputerConfigFilePath()),
                    'computer-runtime',
                    'supervisor-config.json'
                  ),
                  'utf8'
                )
              )
            } catch {
              return undefined
            }
          })()
        : undefined
    // Supervised: of its own config file only the roots its loopback hub set — see
    // supervisedComputerConfigFile (they used to be lost on every restart).
    const snapshot =
      !workerBoot && !supervised
        ? readComputerConfigSnapshot(undefined, { allowLegacy: !savedSeed?.currentFileSeen })
        : {
            config: supervised && !workerBoot ? supervisedComputerConfigFile() : {},
            fingerprint: 'absent',
            currentFileSeen: false
          }
    const candidateSeed: ComputerBootSeed = (process.argv.includes('--supervisor')
      ? savedSeed
      : undefined) ?? {
      fileFingerprint: snapshot.fingerprint,
      ...(prompted.unsaved
        ? {
            launchOverrides: {
              ...(prompted.name !== undefined ? { computerName: prompted.name } : {}),
              ...(prompted.allowedRoots !== undefined
                ? { allowedRoots: prompted.allowedRoots }
                : {})
            }
          }
        : {})
    }
    bootSeed = {
      fileFingerprint: snapshot.fingerprint,
      ...(snapshot.currentFileSeen ? { currentFileSeen: true } : {}),
      ...(candidateSeed.fileFingerprint === snapshot.fingerprint && candidateSeed.launchOverrides
        ? { launchOverrides: candidateSeed.launchOverrides }
        : {})
    }
    config =
      workerBoot?.config ??
      loadBootComputerConfig(bootSeed, process.env, snapshot.config, snapshot.fingerprint)
    if (!workerBoot && !supervised && process.argv.includes('--supervisor'))
      atomicRuntimeJson(
        join(dirname(getComputerConfigFilePath()), 'computer-runtime', 'supervisor-config.json'),
        bootSeed
      )
  } catch (err) {
    process.stderr.write(`slayzone-computer: ${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write(
      `usage: ${ENV_VARS.hubAddress}=<hub-host[:port]> [${ENV_VARS.joinToken}=<token>] slayzone-computer\n`
    )
    process.exitCode = 1
    return
  }

  // FS path-jail default: if the operator declared no allowedRoots (computer.config.json),
  // scope the computer to its own ROOT (the launch dir / SLAYZONE_ROOT). This is a
  // narrow, locally-owned default — NOT the whole home dir, and NEVER hub-pushed.
  // An operator widens it by listing project dirs under `allowedRoots` in
  // <ROOT>/computer.config.json. loadComputerConfig stays hermetic; the default is applied
  // here where SLAYZONE_ROOT is resolved.
  if (config.allowedRoots.length === 0 && process.env.SLAYZONE_ROOT) {
    config.allowedRoots = [process.env.SLAYZONE_ROOT]
  }

  if (!supervised && !workerBoot && !process.argv.includes('--supervisor')) {
    const root = dirname(getComputerConfigFilePath())
    const launcher = ensureComputerLauncher(root, {
      entry: process.argv[1],
      version: COMPUTER_VERSION
    })
    atomicRuntimeJson(join(root, 'computer-runtime', 'supervisor-config.json'), bootSeed)
    const child = fork(launcher, [], {
      stdio: 'inherit',
      env: { ...process.env, SLAYZONE_NONINTERACTIVE: '1' }
    })
    process.on('SIGINT', () => child.kill('SIGINT'))
    process.on('SIGTERM', () => child.kill('SIGTERM'))
    child.on('exit', (code) => {
      process.exitCode = code ?? 1
    })
    child.on('error', (err) => {
      process.stderr.write(String(err))
      process.exitCode = 1
    })
    return
  }

  const log = (message: string, meta?: Record<string, unknown>): void => {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
    process.stdout.write(`[computer] ${message}${suffix}\n`)
  }

  // A certificate pin from an older release is ignored, never enforced (see
  // ignoredCertPinNotices) — said once at boot so the change is not silent.
  for (const notice of ignoredCertPinNotices()) log(notice)

  // Agent lifecycle hooks, BEFORE accepting any work. This computer spawns agents,
  // and their status (running spinner, unread marker) is reported only through
  // these hooks — a box that never runs the desktop app would otherwise have none
  // installed, and every agent here would look permanently idle. Awaited so no pty
  // can start against a half-written hook file; best-effort inside, so a failure
  // degrades status reporting without stopping the computer.
  //
  // Skipped when SUPERVISED: the Electron host installs the very same files from
  // the very same shared installers during its own boot, so doing it again here
  // would be two writers racing for no gain.
  if (!supervised && !workerBoot) {
    const { stageComputerHooks } = await import('./agent-hooks')
    await stageComputerHooks(dirname(getComputerConfigFilePath()), COMPUTER_VERSION, true).catch(
      (err) => {
        log('agent hook install failed', { error: String(err) })
      }
    )
  }

  // The user's login-shell PATH: every process this computer starts inherits
  // process.env, and started from the Dock or a service manager that PATH is the
  // OS's bare one. Probed alongside enrollment, not before it — a heavy zshrc takes
  // ~1s — and requests that can need it wait for it (see `pathReady`).
  const pathReady = adoptLoginShellPath().then((adopted) =>
    log(
      adopted
        ? `PATH: adopted login-shell PATH (+${adopted.added.length} entries)`
        : 'PATH: no login-shell PATH probed — keeping the inherited one'
    )
  )

  if (!supervised && !workerBoot) {
    await pathReady
    await superviseUpgrades(
      config,
      { version: COMPUTER_VERSION, entry: process.argv[1] },
      dirname(getComputerConfigFilePath()),
      log,
      { bootSeed }
    )
    return
  }

  // The desktop app's local-computer supervisor (SUPERVISED, which opens an IPC
  // channel on spawn) talks to this computer over supervisor-ipc.ts: hub reports up,
  // and the set of hubs it serves besides its primary, down. Created before the
  // computer starts so every connection — the primary's too — is reported from its
  // first event.
  const reportsToSupervisor = !workerBoot && supervised && !!process.send
  const supervisorIpc = reportsToSupervisor
    ? createSupervisorIpc({
        send: (message) => {
          if (!process.connected) return false
          process.send?.(message, () => undefined)
          return true
        },
        log
      })
    : undefined

  const handle = workerBoot?.grant
    ? await startConnector(
        dirname(getComputerConfigFilePath()),
        config,
        workerBoot.grant,
        workerBoot.probation
      )
    : startComputer(config, {
        initiallyPaused: workerBoot?.probation,
        log,
        pathReady,
        ...(supervisorIpc
          ? {
              onConnection: supervisorIpc.reportConnection,
              refreshJoinTokenFor: supervisorIpc.requestJoinToken
            }
          : {}),
        onShutdown: () => {
          process.exitCode = 0
          if (workerBoot) {
            process.send?.({ type: 'shutdown' }, () => {
              if (process.connected) process.disconnect()
            })
          }
        }
      })

  // Only the PRIMARY hub decides the exit code (bad join token / missing creds → 1,
  // no longer recognized → 78); see watchPrimaryHubExitCode. A secondary hub's fatal
  // reaches the desktop parent as a `hub-error` message instead.
  watchPrimaryHubExitCode(handle.dialer, (code) => {
    process.exitCode = code
  })

  // Hub connection reports for the parent. Two parents listen: the upgrade
  // supervisor (worker boot) and the desktop app's local-computer supervisor
  // (SUPERVISED) — the app's boot splash waits for `connected` so the app never
  // opens onto a computer that cannot run anything yet. The desktop parent's
  // channel must never keep a stopping computer's loop alive: a clean supervised
  // stop ends by the loop draining. A 'message' listener REFS the channel (measured
  // under Electron's Node 24), so it is unref'd again once the listener is in.
  if (supervisorIpc) {
    process.channel?.unref()
    process.on('message', (message: unknown) => supervisorIpc.handleMessage(message, handle))
    process.channel?.unref()
    supervisorIpc.ready()
  }
  if (workerBoot) {
    for (const dialer of handle.dialers) {
      const hubUrl = effectiveHubUrls(config)[handle.dialers.indexOf(dialer)]
      dialer.events.on('connected', () =>
        process.send?.({ type: 'connected', hubUrl }, () => undefined)
      )
      dialer.events.on('disconnected', () =>
        process.send?.({ type: 'disconnected', hubUrl }, () => undefined)
      )
    }
  }

  if (workerBoot) {
    for (const dialer of handle.dialers) {
      dialer.events.on('error', ({ fatal, error }) => {
        if (fatal) process.send?.({ type: 'fatal', error: error.message }, () => undefined)
      })
    }
    process.on('message', (msg: { type?: string }) => {
      if (msg?.type === 'activate') {
        void Promise.resolve()
          .then(() => handle.activate())
          .then(
            () => process.send?.({ type: 'activated' }, () => undefined),
            (err) => process.send?.({ type: 'fatal', error: String(err) }, () => undefined)
          )
      }
      if (msg?.type === 'drain')
        process.send?.({ type: 'drained', idle: handle.drainForUpgrade() }, () => undefined)
    })
  }

  let stopping = false
  const gracefulStop = (why: string): void => {
    if (stopping) return
    stopping = true
    log(why)
    // Supervised: bounded. A stop ends by the event loop draining, so a stop that
    // hangs — or completes but leaves a live handle behind (d468275b5: an fs
    // watch) — keeps the process alive; once the app is gone nothing else would end
    // it, and the computer would be orphaned with every agent pty still under it.
    // While the app lives, its supervisor's SIGKILL on a stop comes only after this
    // deadline (a backstop for a loop too blocked to run it), so the stop gets the
    // full deadline either way. Unref'd: a clean stop still exits the moment the
    // loop drains.
    if (supervised) {
      setTimeout(() => {
        log(`still running ${SUPERVISED_STOP_DEADLINE_MS}ms after stop began — forcing exit`)
        process.exit(1)
      }, SUPERVISED_STOP_DEADLINE_MS).unref()
    }
    // A token request still waiting on the parent must not hold the stop open.
    supervisorIpc?.dispose()
    void handle.stop().then(() => {
      process.exitCode ??= 0
      if (workerBoot && process.connected) process.disconnect()
    })
  }
  process.on('SIGINT', () => gracefulStop('received SIGINT, stopping'))
  process.on('SIGTERM', () => gracefulStop('received SIGTERM, stopping'))
  if (workerBoot)
    process.on('disconnect', () => gracefulStop('upgrade supervisor exited, stopping'))

  // A supervised computer must never outlive the app that spawned it. See
  // @slayzone/platform/parent-watch for the signals and why each is needed.
  // Standalone computers have no such parent and are untouched.
  if (supervised) {
    watchParent({
      onParentDeath: (reason) => gracefulStop(`parent app is gone (${reason}), stopping`)
    })
  }
}

void main()
