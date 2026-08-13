/**
 * slayzone-computer CLI entrypoint.
 *
 *   SLAYZONE_HUB_ADDRESS=hub:8443 \
 *   SLAYZONE_HUB_JOIN_TOKEN=... \
 *   slayzone-computer
 *
 * SLAYZONE_HUB_ADDRESS carries the hub AUTHORITY only (host[:port]); the dial
 * scheme (ws/wss) is derived from SLAYZONE_MODE, and `/computers` is appended.
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

import { hostname } from 'node:os'
import { delimiter } from 'node:path'
import { canPrompt, runInteractiveConfig } from '@slayzone/platform/config-prompt'
import {
  getComputerConfigFilePath,
  loadComputerConfigFile
} from '@slayzone/platform/slayzone-config'
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import { COMPUTER_EXIT_NEEDS_RE_ENROLLMENT } from '@slayzone/computer-transport/shared'
import { createFileCredentialStore, hubHostFromUrl } from '@slayzone/computer-transport/client'
import { ENV_VARS, loadComputerConfig } from './config'
import { startComputer } from './main'

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
}> {
  if (!canPrompt()) return {}

  const cfg = loadComputerConfigFile()
  // A join token is self-sufficient (first contact) → nothing to ask.
  if ((process.env[ENV_VARS.joinToken] ?? cfg.joinToken) !== undefined) return {}

  // Already enrolled? A stored credential for the known hub host means we can
  // reconnect without a token. Skip the prompt in that case. The env channel
  // carries authority only, so compose it into a url (scheme from MODE) before
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
  const out: { name?: string; allowedRoots?: string[] } = {}
  if (typeof collectedName?.config === 'string') out.name = collectedName.config
  if (Array.isArray(collectedRoots?.config)) out.allowedRoots = collectedRoots.config as string[]
  return out
}

async function main(): Promise<void> {
  // ROOT anchoring (standalone only): a bare `slayzone-computer` anchors its
  // computer.config.json + credential store to the launch dir. Seed BEFORE loadComputerConfig
  // (which reads <ROOT>/computer.config.json via getSlayzoneHomeDir). Skipped when
  // supervised — the Electron host supplies the computer's env in full. Operator
  // env still wins (explicit SLAYZONE_ROOT respected).
  if (process.env.SLAYZONE_SUPERVISED !== '1' && !process.env.SLAYZONE_ROOT) {
    process.env.SLAYZONE_ROOT = process.cwd()
  }

  // Interactive first-run setup (TTY only) — may seed the join token into env +
  // write computer.config.json before the resolver below reads them. No-op when
  // non-interactive / enrolled. Returns the prompted display name + path-jail (if
  // any) so a declined-save still applies them this boot (neither has an env
  // channel).
  const prompted = await maybeInteractiveSetup()

  let config
  try {
    config =
      prompted.name !== undefined || prompted.allowedRoots !== undefined
        ? loadComputerConfig(process.env, {
            ...loadComputerConfigFile(),
            ...(prompted.name !== undefined ? { computerName: prompted.name } : {}),
            ...(prompted.allowedRoots !== undefined ? { allowedRoots: prompted.allowedRoots } : {})
          })
        : loadComputerConfig()
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

  const log = (message: string, meta?: Record<string, unknown>): void => {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
    process.stdout.write(`[computer] ${message}${suffix}\n`)
  }

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
  if (process.env.SLAYZONE_SUPERVISED !== '1') {
    const { installAgentHooks } = await import('./agent-hooks')
    await installAgentHooks(log)
  }

  const handle = startComputer(config, {
    log,
    onShutdown: () => {
      process.exitCode = 0
    }
  })

  // The dialer gives up on fatal auth errors (bad join token, missing creds);
  // exit non-zero so supervisors notice instead of idling forever.
  //
  // Exit code 78 (EX_CONFIG, sysexits.h) is reserved for "the hub no longer
  // recognizes this computer". A supervisor cannot fix that by restarting — only an
  // operator re-enrolling can — so it needs to distinguish that from a crash, and
  // an exit code is a far sturdier channel for that than matching a log line.
  handle.dialer.events.on('error', ({ fatal, reason }) => {
    if (reason === 'needs-re-enrollment') {
      process.exitCode = COMPUTER_EXIT_NEEDS_RE_ENROLLMENT
      return
    }
    if (fatal) process.exitCode = 1
  })

  let stopping = false
  const gracefulStop = (signal: string): void => {
    if (stopping) return
    stopping = true
    log(`received ${signal}, stopping`)
    void handle.stop().then(() => {
      process.exitCode ??= 0
    })
  }
  process.on('SIGINT', () => gracefulStop('SIGINT'))
  process.on('SIGTERM', () => gracefulStop('SIGTERM'))
}

void main()
