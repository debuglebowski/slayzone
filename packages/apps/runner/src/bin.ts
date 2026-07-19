/**
 * slayzone-runner CLI entrypoint.
 *
 *   SLAYZONE_HUB_URL=wss://hub:8443/runners \
 *   SLAYZONE_RUNNER_JOIN_TOKEN=... \
 *   slayzone-runner
 *
 * On an interactive terminal a fresh runner (no join token AND no stored
 * credentials) is prompted for its join token + path-jail + name, then offered
 * to persist them to <ROOT>/config.json — see `maybeInteractiveSetup`. Piped /
 * supervised / SLAYZONE_NONINTERACTIVE runs skip that and behave exactly as
 * before (fail-fast usage error when the token is missing).
 *
 * See `config.ts` for the full set of SLAYZONE_* variables and the shared
 * <ROOT>/config.json file.
 */

import { hostname } from 'node:os'
import { delimiter } from 'node:path'
import { canPrompt, runInteractiveConfig } from '@slayzone/platform/config-prompt'
import { loadSlayzoneConfig } from '@slayzone/platform/slayzone-config'
import { createFileCredentialStore, hubHostFromUrl } from '@slayzone/runner-transport/client'
import { ENV_VARS, loadRunnerConfig } from './config'
import { startRunner } from './main'

/**
 * First-run interactive setup for a STANDALONE runner. Runs ONLY when
 * {@link canPrompt} and the runner has no usable way to reach a hub yet:
 *   - no join token (env / config.json), AND
 *   - no stored credentials for an already-known hub URL.
 * In every other case (token present, already enrolled, non-interactive) this
 * is a no-op and the boot is byte-identical to before.
 *
 * Prompts the join token (embeds hub URL + cert pin), the filesystem path-jail
 * (default: the launch dir), and an optional display name (default: hostname —
 * left unset unless the user types a custom one, so it resolves live). The
 * accepted values are seeded into `process.env` and, on a `[Y/n]`-confirm,
 * persisted to <ROOT>/config.json so subsequent boots need no prompt.
 */
async function maybeInteractiveSetup(): Promise<void> {
  if (!canPrompt()) return

  const cfg = loadSlayzoneConfig()
  // A join token is self-sufficient (first contact) → nothing to ask.
  if ((process.env[ENV_VARS.joinToken] ?? cfg.joinToken) !== undefined) return

  // Already enrolled? A stored credential for the known hub host means we can
  // reconnect without a token. Skip the prompt in that case.
  const hubUrl = process.env[ENV_VARS.hubUrl] ?? cfg.hubUrl
  if (hubUrl !== undefined) {
    try {
      const credentialsDir = process.env[ENV_VARS.credentialsDir]
      const store = createFileCredentialStore(
        hubHostFromUrl(hubUrl),
        credentialsDir ? { baseDir: credentialsDir } : {}
      )
      if (await store.load()) return
    } catch {
      // Unreadable url/creds → fall through to prompting.
    }
  }

  const defaultRoot = process.env.SLAYZONE_ROOT ?? process.cwd()
  await runInteractiveConfig({
    title: 'Runner setup — values to save to config.json:',
    fields: [
      {
        configKey: 'joinToken',
        envKey: ENV_VARS.joinToken,
        label: 'Hub join token (from `POST /api/runners/join-token` on the hub)'
      },
      {
        configKey: 'allowedRoots',
        envKey: ENV_VARS.allowedRoots,
        label: 'Filesystem roots the runner may access (comma-separated)',
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
        // No default → an empty answer is SKIPPED (not persisted), so the runner
        // name resolves to the live hostname each boot instead of a pinned value.
        configKey: 'runnerName',
        envKey: ENV_VARS.name,
        label: 'Runner display name',
        hint: `default: ${hostname()}`
      }
    ]
  })
}

async function main(): Promise<void> {
  // ROOT anchoring (standalone only): a bare `slayzone-runner` anchors its
  // config.json + credential store to the launch dir. Seed BEFORE loadRunnerConfig
  // (which reads <ROOT>/config.json via getSlayzoneHomeDir). Skipped when
  // supervised — the Electron host supplies the runner's env in full. Operator
  // env still wins (explicit SLAYZONE_ROOT respected).
  if (
    process.env.SLAYZONE_SUPERVISED !== '1' &&
    !process.env.SLAYZONE_ROOT &&
    !process.env.SLAYZONE_HOME_DIR
  ) {
    process.env.SLAYZONE_ROOT = process.cwd()
  }

  // Interactive first-run setup (TTY only) — may seed env + write config.json
  // before the resolver below reads them. No-op when non-interactive / enrolled.
  await maybeInteractiveSetup()

  let config
  try {
    config = loadRunnerConfig()
  } catch (err) {
    process.stderr.write(`slayzone-runner: ${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write(
      `usage: ${ENV_VARS.hubUrl}=wss://<hub>/runners [${ENV_VARS.joinToken}=<token>] slayzone-runner\n`
    )
    process.exitCode = 1
    return
  }

  // FS path-jail default: if the operator declared no allowedRoots (config.json),
  // scope the runner to its own ROOT (the launch dir / SLAYZONE_ROOT). This is a
  // narrow, locally-owned default — NOT the whole home dir, and NEVER hub-pushed.
  // An operator widens it by listing project dirs under `allowedRoots` in
  // <ROOT>/config.json. loadRunnerConfig stays hermetic; the default is applied
  // here where SLAYZONE_ROOT is resolved.
  if (config.allowedRoots.length === 0 && process.env.SLAYZONE_ROOT) {
    config.allowedRoots = [process.env.SLAYZONE_ROOT]
  }

  const log = (message: string, meta?: Record<string, unknown>): void => {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
    process.stdout.write(`[runner] ${message}${suffix}\n`)
  }

  const handle = startRunner(config, {
    log,
    onShutdown: () => {
      process.exitCode = 0
    }
  })

  // The dialer gives up on fatal auth errors (bad join token, missing creds);
  // exit non-zero so supervisors notice instead of idling forever.
  handle.dialer.events.on('error', ({ fatal }) => {
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
