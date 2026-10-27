import { canPrompt, runInteractiveConfig } from '@slayzone/platform/config-prompt'
import { SUPERVISED_STOP_DEADLINE_MS, watchParent } from '@slayzone/platform/parent-watch'
import { securityEvent } from '@slayzone/platform/security-log'
import { getHubConfigFilePath, loadHubConfigFile } from '@slayzone/platform/slayzone-config'
import { bootRefusalRule } from './boot-rules.js'
import { runBreakGlassCommand } from './break-glass-command.js'
import { startServer } from './server.js'
import { applyStandaloneHubConfig } from './standalone-config.js'
import type { ServerHandle } from './index.js'

/**
 * First-run interactive setup for a STANDALONE hub. Runs ONLY when
 * {@link canPrompt}. The hub auto-generates its secret and defaults its ports, so
 * this asks for the ONE optional value that a hub other machines connect to needs:
 * the public address that minted join tokens embed. Leaving it empty is fine for a
 * loopback-only hub — an empty answer is skipped, so nothing is written and no
 * re-prompt occurs once the operator has answered once (a persisted value stops
 * being missing). A public address makes the hub reachable from other machines, so
 * the hub then also requires SLAYZONE_HUB_REQUIRE_LOGIN=1 and SLAYZONE_HUB_AUTH_SECRET
 * (boot rules B1, B14) — the hint says so.
 *
 * Called BEFORE applyStandaloneHubConfig so an accepted value is already in
 * `process.env` when the standard env-first resolver runs — keeping the rest of
 * the boot byte-identical. No-op when non-interactive / already set.
 */
async function maybeInteractiveSetup(): Promise<void> {
  if (!canPrompt()) return
  const cfg = loadHubConfigFile()
  if ((process.env.SLAYZONE_HUB_PUBLIC_ADDRESS ?? cfg.publicAddress) !== undefined) return

  await runInteractiveConfig({
    title: 'Hub setup — values to save to hub.config.json:',
    configPath: getHubConfigFilePath(),
    fields: [
      {
        configKey: 'publicAddress',
        envKey: 'SLAYZONE_HUB_PUBLIC_ADDRESS',
        // Authority only — the scheme follows the host (loopback → http, else
        // https), so asking for it here would let the two disagree.
        label: 'Public hub address for remote computers (leave empty for loopback-only)',
        hint:
          'host[:port], e.g. hub.example.com:8443. Setting it makes the hub reachable from ' +
          'other machines, which then requires SLAYZONE_HUB_REQUIRE_LOGIN=1 and ' +
          'SLAYZONE_HUB_AUTH_SECRET in the environment.'
      }
    ]
  })
}

async function main(): Promise<void> {
  // Started by the desktop app (sidecar-server-supervisor.ts), which owns this hub's
  // env, root and lifetime.
  const supervised = process.env.SLAYZONE_SUPERVISED === '1'

  // Interactive first-run setup (TTY only) — may seed env + write hub.config.json
  // before applyStandaloneHubConfig reads it. No-op when non-interactive / set.
  await maybeInteractiveSetup()

  // Standalone-only: fold hub.config.json/hub.state.json into process.env
  // (env-wins) + resolve/persist the computer secret, BEFORE any downstream env
  // reader runs. A no-op under SLAYZONE_SUPERVISED=1 (the desktop app owns the env
  // + secret), so the supervised sidecar boot is byte-identical. See
  // ./standalone-config.ts.
  applyStandaloneHubConfig()

  const handle: ServerHandle = await startServer()

  process.stdout.write(
    `[slayzone-server] listening on http://${handle.host}:${handle.port} ` +
      `(data=${handle.dataRoot} db=${handle.dbPath})\n`
  )

  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write(`[slayzone-server] shutting down (${reason})\n`)
    // Supervised: bounded. A stop that hangs — a client connection the hub's HTTP
    // server waits on before it closes (a `slay` subscription, a web-shell tab) —
    // keeps the process alive; once the app is gone nothing else would end it, and
    // the hub would be orphaned holding the port and the database the next app's
    // hub needs. While the app lives, its supervisor's SIGKILL comes only after this
    // deadline (a backstop for a loop too blocked to run it), so the stop gets the
    // full deadline either way. Unref'd: a clean stop still exits the moment it
    // completes.
    if (supervised) {
      setTimeout(() => {
        process.stderr.write(
          `[slayzone-server] still running ${SUPERVISED_STOP_DEADLINE_MS}ms after stop began — forcing exit\n`
        )
        process.exit(1)
      }, SUPERVISED_STOP_DEADLINE_MS).unref()
    }
    try {
      await handle.stop()
      process.exit(0)
    } catch (err) {
      process.stderr.write(
        `[slayzone-server] shutdown error: ${err instanceof Error ? err.stack : String(err)}\n`
      )
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Parent-death detection: when launched by the Electron supervisor, the
  // side-car stops itself once its parent dies — clean exit OR kill -9. See
  // @slayzone/platform/parent-watch for the signals and why each is needed.
  // Standalone runs (SLAYZONE_SUPERVISED unset) skip this so a closed shell stdin
  // does not kill a manually-run server.
  if (supervised) {
    watchParent({ onParentDeath: (reason) => void shutdown(reason) })
  }
}

// `slayzone-hub break-glass …` (break-glass-command.ts) is an operator command against
// the RUNNING hub over its local socket: it starts no hub of its own.
if (process.argv[2] === 'break-glass') {
  void runBreakGlassCommand(process.argv.slice(3)).then((code) => {
    // Exit explicitly: the hub's modules are loaded and may hold the loop open.
    process.exitCode = code
    process.stdout.write('', () => process.exit(code))
  })
} else {
  main().catch((err) => {
    // A boot rule's refusal is a security event: one audit line naming the rule
    // (T-03). Any other boot failure is not, and stays on stderr only.
    const rule = bootRefusalRule(err)
    if (rule) {
      securityEvent({
        event: 'hub.boot',
        outcome: 'denied',
        level: 'error',
        targetKind: 'hub',
        detail: { rule }
      })
    }
    process.stderr.write(
      `[slayzone-server] fatal: ${err instanceof Error ? err.stack : String(err)}\n`
    )
    // stdout is asynchronous on a macOS pipe: let the audit line out before exiting.
    // `exitCode` covers the loop draining on its own before either fires.
    process.exitCode = 1
    setTimeout(() => process.exit(1), 2_000).unref()
    process.stdout.write('', () => process.exit(1))
  })
}
