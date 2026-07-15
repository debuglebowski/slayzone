/**
 * Standalone-boot config resolution for the hub.
 *
 * Folds the shared `~/.slayzone/config.json` (see @slayzone/platform/
 * slayzone-config) into `process.env` at the very start of a STANDALONE boot,
 * filling ONLY the env vars that are currently unset — so the precedence is
 * `env var > config.json > default` for every downstream reader
 * (db.ts getDatabasePathFromEnv, composition.ts SLAYZONE_FLEET_MODE/
 * SLAYZONE_FLEET_SECRET, server.ts getTrpcPort/getServerHost/
 * SLAYZONE_FLEET_PORT, remote-mcp-env-provider SLAYZONE_HUB_PUBLIC_URL). Nothing
 * downstream changes — they still read env exactly as before; we just seed env
 * from the file first. This keeps the whole server pipeline byte-identical apart
 * from where a value ultimately comes from.
 *
 * SUPERVISED (`SLAYZONE_SUPERVISED=1`, Electron host): this is a NO-OP — it
 * neither reads nor writes the config file, so the supervised sidecar boot stays
 * byte-identical to today (its env is fully supplied by the Electron host).
 *
 * SECURITY SEAM (fleet secret): the standalone boot resolves the fleet secret
 * (`env SLAYZONE_FLEET_SECRET > config.json fleetSecret > generate + persist`)
 * and sets `process.env.SLAYZONE_FLEET_SECRET` to it BEFORE composeServer runs.
 * composition.ts then reads that env value and NEVER falls back to the shared
 * `'slayzone-dev-fleet-secret'` dev constant in standalone (that forgeable-token
 * default now only applies in supervised/dev, where the Electron host controls
 * the secret). The generated secret is 256-bit and persisted 0600 so it is
 * stable across reboots.
 *
 * @module hub/standalone-config
 */

import { ensureFleetSecret, loadSlayzoneConfig } from '@slayzone/platform/slayzone-config'

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

  // fleetMode (bool) → SLAYZONE_FLEET_MODE. Precedence: env (if set) > config.json
  // fleetMode (true OR false, when the key is present) > default(off). The config
  // key can ENABLE *and* DISABLE fleet: composition.ts gates on
  // `SLAYZONE_FLEET_MODE === '1'`, so we set '1' for true and '0' for false — a
  // present-but-false key thus forces fleet off even if some other default were to
  // flip. env untouched when already set (env wins).
  if (process.env.SLAYZONE_FLEET_MODE === undefined && cfg.fleetMode !== undefined) {
    process.env.SLAYZONE_FLEET_MODE = cfg.fleetMode ? '1' : '0'
  }
  setIfUnset('SLAYZONE_DB_PATH', cfg.dbPath)
  setIfUnset('SLAYZONE_PORT', cfg.port !== undefined ? String(cfg.port) : undefined)
  setIfUnset('SLAYZONE_FLEET_PORT', cfg.fleetPort !== undefined ? String(cfg.fleetPort) : undefined)
  setIfUnset('SLAYZONE_HUB_PUBLIC_URL', cfg.publicUrl)

  // Fleet secret — security fix. Resolve env > config > generate+persist and set
  // the env so composition.ts never reaches the shared dev constant in standalone.
  // ensureFleetSecret returns the config value if present, else generates + writes
  // a fresh 256-bit secret to config.json (0600, atomic create-if-absent). An
  // EMPTY env value counts as ABSENT (env-wins only when meaningfully set) — so a
  // stray `SLAYZONE_FLEET_SECRET=''` generates rather than tripping composition's
  // fail-loud guard. A non-empty env pin is left untouched (CI path, no write).
  if (!process.env.SLAYZONE_FLEET_SECRET) {
    process.env.SLAYZONE_FLEET_SECRET = ensureFleetSecret()
  }
}
