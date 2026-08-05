/**
 * Standalone-boot config resolution for the hub.
 *
 * Folds `hub.config.json`/`hub.state.json` (see @slayzone/platform/
 * slayzone-config) into `process.env` at the very start of a STANDALONE boot,
 * filling ONLY the env vars that are currently unset — so the precedence is
 * `env var > file > default` for every downstream reader
 * (db.ts getDatabasePathFromEnv, composition.ts
 * SLAYZONE_HUB_AUTH_SECRET, server.ts getTrpcPort/getServerHost,
 * remote-mcp-env-provider SLAYZONE_HUB_PUBLIC_ADDRESS). Nothing downstream changes —
 * they still read env exactly as before; we just seed env from the file first.
 * This keeps the whole server pipeline byte-identical apart from where a value
 * ultimately comes from.
 *
 * SUPERVISED (`SLAYZONE_SUPERVISED=1`, Electron host): this is a NO-OP — it
 * neither reads nor writes the config file, so the supervised sidecar boot stays
 * byte-identical to today (its env is fully supplied by the Electron host).
 *
 * SECURITY SEAM (hub-auth secret): the standalone boot resolves the secret
 * (`env SLAYZONE_HUB_AUTH_SECRET > hub.state.json runnerTransportSecret > generate + persist`)
 * and sets `process.env.SLAYZONE_HUB_AUTH_SECRET` to it BEFORE composeServer runs.
 * composition.ts then reads that env value and NEVER falls back to the shared
 * `'slayzone-dev-runner-secret'` dev constant in standalone (that forgeable-token
 * default now only applies in supervised/dev, where the Electron host controls
 * the secret). The generated secret is 256-bit and persisted 0600 so it is
 * stable across reboots.
 *
 * @module hub/standalone-config
 */

import {
  ensureHubAuthSecret,
  loadHubConfigFile,
  resolveHubName
} from '@slayzone/platform/slayzone-config'

/** True when the hub is running under the Electron host supervisor. */
function isSupervised(): boolean {
  return process.env.SLAYZONE_SUPERVISED === '1'
}

/**
 * Extract the authority (`host[:port]`) from a legacy full-URL config value,
 * discarding its scheme and path. Returns undefined for an absent or unparseable
 * value, so the caller simply leaves the env var unset.
 */
function authorityOf(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    const host = new URL(rawUrl).host
    return host === '' ? undefined : host
  } catch {
    return undefined
  }
}

/**
 * Seed `process.env` for a standalone hub boot from `hub.config.json`.
 * Call ONCE at the top of the standalone entrypoint (bin.ts), before startServer.
 * Returns silently (no file access) when supervised.
 *
 * ROOT anchoring: a standalone hub anchors ALL on-disk state to `SLAYZONE_ROOT`,
 * defaulting to the launch directory (`process.cwd()`). This MUST be seeded
 * before `loadHubConfigFile()` runs, because the config file itself lives at
 * `<ROOT>/hub.config.json` (getSlayzoneHomeDir reads SLAYZONE_ROOT). The DB +
 * logs + diagnostics live directly under `<ROOT>` (flattened, no `storage/`
 * layer) from the same root, so a bare `slayzone-hub` in an empty dir keeps
 * everything local to it.
 */
export function applyStandaloneHubConfig(): void {
  if (isSupervised()) return

  // env-wins: only fill an env var the operator/CI has NOT already set.
  const setIfUnset = (key: string, value: string | undefined): void => {
    if (value !== undefined && process.env[key] === undefined) process.env[key] = value
  }

  // Anchor to the launch dir FIRST, so the config-file lookup below resolves
  // under ROOT. Only default when SLAYZONE_ROOT is unset — an explicit
  // SLAYZONE_ROOT (E2E/test sandbox, power-user relocation) is respected.
  if (!process.env.SLAYZONE_ROOT) {
    process.env.SLAYZONE_ROOT = process.cwd()
  }
  const cfg = loadHubConfigFile()

  // Deployment hardening intent. Seeded FIRST because everything below is read in
  // light of it: the scheme of the join-token URL, whether client auth is enforced,
  // whether TLS terminates here. Only the two known literals reach here (coerce
  // drops anything else), and env wins as always — so a hub with no `mode` key
  // stays byte-identical, defaulting to `local` inside getSlayzoneMode().
  setIfUnset('SLAYZONE_MODE', cfg.mode)
  // No dir- or file-pointing var is seeded: the DB + state dir DERIVE from
  // SLAYZONE_ROOT (seeded above) via platform.getStorageDir() → `<ROOT>` directly.
  // Everything (hub db.ts, ensureDataRoot) computes that same path from ROOT, so
  // there is nothing to thread through env here.
  // The hub's own address. `address` is the current key; the legacy `port` key is
  // still honored (loopback + that port) so an existing config.json keeps booting.
  setIfUnset(
    'SLAYZONE_HUB_ADDRESS',
    cfg.address ?? (cfg.port !== undefined ? `127.0.0.1:${cfg.port}` : undefined)
  )
  // The hub's external address, written into join tokens. Legacy `publicUrl` is
  // still honored by extracting its authority — the scheme it carried is
  // deliberately discarded (SLAYZONE_MODE decides the scheme now).
  setIfUnset('SLAYZONE_HUB_PUBLIC_ADDRESS', cfg.publicAddress ?? authorityOf(cfg.publicUrl))

  // Operator-facing hub name, reported over /health so `slay hub ls` can label +
  // address this hub. resolveHubName applies env > config > basename(ROOT); seed
  // the env so every later reader (health state, logs) sees one settled value.
  // A blank env value is treated as unset by resolveHubName, so overwrite it
  // rather than using setIfUnset — a nameless hub could never be addressed.
  if (!process.env.SLAYZONE_HUB_NAME?.trim()) {
    process.env.SLAYZONE_HUB_NAME = resolveHubName()
  }

  // Hub-auth secret — security fix. Resolve env > state file > generate+persist and
  // set the env so composition.ts never reaches the shared dev constant in standalone.
  // ensureHubAuthSecret returns the state-file value if present, else generates + writes
  // a fresh 256-bit secret to hub.state.json (0600, atomic create-if-absent). An
  // EMPTY env value counts as ABSENT (env-wins only when meaningfully set) — so a
  // stray `SLAYZONE_HUB_AUTH_SECRET=''` generates rather than tripping composition's
  // fail-loud guard. A non-empty env pin is left untouched (CI path, no write).
  if (!process.env.SLAYZONE_HUB_AUTH_SECRET) {
    process.env.SLAYZONE_HUB_AUTH_SECRET = ensureHubAuthSecret()
  }
}
