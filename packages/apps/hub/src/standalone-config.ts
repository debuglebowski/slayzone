/**
 * Standalone-boot config resolution for the hub.
 *
 * Folds the shared `~/.slayzone/config.json` (see @slayzone/platform/
 * slayzone-config) into `process.env` at the very start of a STANDALONE boot,
 * filling ONLY the env vars that are currently unset — so the precedence is
 * `env var > config.json > default` for every downstream reader
 * (db.ts getDatabasePathFromEnv, composition.ts
 * SLAYZONE_RUNNER_TRANSPORT_SECRET, server.ts getTrpcPort/getServerHost/
 * SLAYZONE_RUNNER_TRANSPORT_PORT, remote-mcp-env-provider SLAYZONE_HUB_PUBLIC_URL). Nothing
 * downstream changes — they still read env exactly as before; we just seed env
 * from the file first. This keeps the whole server pipeline byte-identical apart
 * from where a value ultimately comes from.
 *
 * SUPERVISED (`SLAYZONE_SUPERVISED=1`, Electron host): this is a NO-OP — it
 * neither reads nor writes the config file, so the supervised sidecar boot stays
 * byte-identical to today (its env is fully supplied by the Electron host).
 *
 * SECURITY SEAM (runner secret): the standalone boot resolves the runner secret
 * (`env SLAYZONE_RUNNER_TRANSPORT_SECRET > config.json runnerTransportSecret > generate + persist`)
 * and sets `process.env.SLAYZONE_RUNNER_TRANSPORT_SECRET` to it BEFORE composeServer runs.
 * composition.ts then reads that env value and NEVER falls back to the shared
 * `'slayzone-dev-runner-secret'` dev constant in standalone (that forgeable-token
 * default now only applies in supervised/dev, where the Electron host controls
 * the secret). The generated secret is 256-bit and persisted 0600 so it is
 * stable across reboots.
 *
 * @module hub/standalone-config
 */

import { ensureRunnerTransportSecret, loadSlayzoneConfig } from '@slayzone/platform/slayzone-config'

/** True when the hub is running under the Electron host supervisor. */
function isSupervised(): boolean {
  return process.env.SLAYZONE_SUPERVISED === '1'
}

/**
 * Seed `process.env` from `~/.slayzone/config.json` for a standalone hub boot.
 * Call ONCE at the top of the standalone entrypoint (bin.ts), before startServer.
 * Returns silently (no file access) when supervised.
 */
export function applyStandaloneHubConfig(): void {
  if (isSupervised()) return

  const cfg = loadSlayzoneConfig()

  // env-wins: only fill an env var the operator/CI has NOT already set.
  const setIfUnset = (key: string, value: string | undefined): void => {
    if (value !== undefined && process.env[key] === undefined) process.env[key] = value
  }

  setIfUnset('SLAYZONE_DB_PATH', cfg.dbPath)
  setIfUnset('SLAYZONE_PORT', cfg.port !== undefined ? String(cfg.port) : undefined)
  setIfUnset('SLAYZONE_RUNNER_TRANSPORT_PORT', cfg.runnerTransportPort !== undefined ? String(cfg.runnerTransportPort) : undefined)
  setIfUnset('SLAYZONE_HUB_PUBLIC_URL', cfg.publicUrl)

  // Runner secret — security fix. Resolve env > config > generate+persist and set
  // the env so composition.ts never reaches the shared dev constant in standalone.
  // ensureRunnerTransportSecret returns the config value if present, else generates + writes
  // a fresh 256-bit secret to config.json (0600, atomic create-if-absent). An
  // EMPTY env value counts as ABSENT (env-wins only when meaningfully set) — so a
  // stray `SLAYZONE_RUNNER_TRANSPORT_SECRET=''` generates rather than tripping composition's
  // fail-loud guard. A non-empty env pin is left untouched (CI path, no write).
  if (!process.env.SLAYZONE_RUNNER_TRANSPORT_SECRET) {
    process.env.SLAYZONE_RUNNER_TRANSPORT_SECRET = ensureRunnerTransportSecret()
  }
}
