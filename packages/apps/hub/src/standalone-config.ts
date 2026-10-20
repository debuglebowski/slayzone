/**
 * Standalone-boot config resolution for the hub.
 *
 * Folds `hub.config.json`/`hub.state.json` (see @slayzone/platform/
 * slayzone-config) into `process.env` at the very start of a STANDALONE boot,
 * filling ONLY the env vars that are currently unset — so the precedence is
 * `env var > file > default` for every downstream reader
 * (db.ts getDatabasePathFromEnv, composition.ts
 * SLAYZONE_HUB_AUTH_SECRET, server.ts getTrpcPort/getServerHost,
 * remote-mcp-env-provider SLAYZONE_HUB_PUBLIC_ADDRESS, boot-rules.ts the switches).
 * Nothing downstream changes — they still read env; we just seed env from the file
 * first. The file's keys are listed in `HubConfig`: listenAddress, publicAddress,
 * hubName, the five switches and the two non-secret SSO ids. Secrets (the auth
 * secret, the SSO client secret) are env only.
 *
 * A file that still uses a RENAMED key (`address`, `port`, `publicUrl`) or holds a
 * non-boolean switch refuses boot (B5 / B4) — honoring the old key would silently
 * put the hub on an address the operator no longer controls, and a switch that
 * fell back to its default on a typo would fail open. A leftover `mode` key is
 * ignored: SLAYZONE_MODE no longer exists.
 *
 * SUPERVISED (`SLAYZONE_SUPERVISED=1`, Electron host): this is a NO-OP — it
 * neither reads nor writes the config file, so the supervised sidecar boot stays
 * byte-identical to today (its env is fully supplied by the Electron host).
 *
 * SECURITY SEAM (hub-auth secret): a hub that only this machine can reach resolves
 * the secret (`env SLAYZONE_HUB_AUTH_SECRET > hub.state.json computerTransportSecret >
 * generate + persist`) and sets `process.env.SLAYZONE_HUB_AUTH_SECRET` to it BEFORE
 * composeServer runs. composition.ts then reads that env value and NEVER falls back
 * to the shared `'slayzone-dev-computer-secret'` dev constant in standalone (that
 * forgeable-token default now only applies in supervised/dev, where the Electron
 * host controls the secret). The generated secret is 256-bit and persisted 0600 so
 * it is stable across reboots.
 *
 * A hub that OTHER machines can reach (B13: non-loopback listen address, or a public
 * address) never generates one: it is left unset here and boot rule B14 refuses it,
 * so a signing key that protects every session and computer credential is never
 * written onto the hub's own disk by default.
 *
 * @module hub/standalone-config
 */

import { HUB_ADDRESS_ENV, HUB_SSO_ENV, HUB_SWITCH_ENV } from '@slayzone/platform/hub-switches'
import {
  HUB_CONFIG_SWITCH_KEYS,
  ensureHubAuthSecret,
  getHubConfigFilePath,
  loadHubConfigFile,
  loadHubConfigProblems,
  resolveHubName
} from '@slayzone/platform/slayzone-config'
import { assertHubBootRulesFromEnv, peekHubReachability } from './boot-rules.js'

/** True when the hub is running under the Electron host supervisor. */
function isSupervised(): boolean {
  return process.env.SLAYZONE_SUPERVISED === '1'
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
  // Renamed keys and malformed switches refuse boot BEFORE anything is seeded from
  // the file (B5, B4): see the module doc.
  const problems = loadHubConfigProblems()
  if (problems.length > 0) {
    throw new Error(
      `[slayzone] ${getHubConfigFilePath()} cannot be used: ` +
        `${problems.map((p) => p.message).join('; ')}. Update the file — a renamed key is ` +
        `never honored silently.`
    )
  }
  const cfg = loadHubConfigFile()

  // No dir- or file-pointing var is seeded: the DB + state dir DERIVE from
  // SLAYZONE_ROOT (seeded above) via platform.getStorageDir() → `<ROOT>` directly.
  // Everything (hub db.ts, ensureDataRoot) computes that same path from ROOT, so
  // there is nothing to thread through env here.
  //
  // Where the hub listens, and the external address written into join tokens.
  setIfUnset(HUB_ADDRESS_ENV.listen, cfg.listenAddress)
  setIfUnset(HUB_ADDRESS_ENV.public, cfg.publicAddress)

  // The per-hub switches. The file holds booleans; the env channel (and everything
  // that reads it) holds `0|1`. Only a key that is actually in the file is seeded, so
  // an absent one keeps its default — the desktop app's hub.
  for (const key of HUB_CONFIG_SWITCH_KEYS) {
    const value = cfg[key]
    setIfUnset(HUB_SWITCH_ENV[key], value === undefined ? undefined : value ? '1' : '0')
  }
  // The non-secret SSO settings. The client secret has NO file key, on purpose.
  setIfUnset(HUB_SSO_ENV.tenantId, cfg.ssoTenantId)
  setIfUnset(HUB_SSO_ENV.clientId, cfg.ssoClientId)

  // Operator-facing hub name, reported over /health so `slay hub ls` can label +
  // address this hub. resolveHubName applies env > config > basename(ROOT); seed
  // the env so every later reader (health state, logs) sees one settled value.
  // A blank env value is treated as unset by resolveHubName, so overwrite it
  // rather than using setIfUnset — a nameless hub could never be addressed.
  if (!process.env.SLAYZONE_HUB_NAME?.trim()) {
    process.env.SLAYZONE_HUB_NAME = resolveHubName()
  }

  // Every boot rule now, ahead of the one thing below that writes to disk (the
  // generated secret): a hub that is going to be refused must leave nothing behind.
  // `startServer` runs them again against the host it binds.
  assertHubBootRulesFromEnv()

  // Hub-auth secret — security fix. Resolve env > state file > generate+persist and
  // set the env so composition.ts never reaches the shared dev constant in standalone.
  // ensureHubAuthSecret returns the state-file value if present, else generates + writes
  // a fresh 256-bit secret to hub.state.json (0600, atomic create-if-absent). An
  // EMPTY env value counts as ABSENT (env-wins only when meaningfully set) — so a
  // stray `SLAYZONE_HUB_AUTH_SECRET=''` generates rather than tripping composition's
  // fail-loud guard. A non-empty env pin is left untouched (CI path, no write).
  //
  // NOT for a hub other machines can reach (B13): that one must be given its secret
  // in the environment, so nothing is generated or read from disk here and boot
  // rule B14 refuses it when it is missing.
  if (!process.env.SLAYZONE_HUB_AUTH_SECRET && !peekHubReachability(process.env)) {
    process.env.SLAYZONE_HUB_AUTH_SECRET = ensureHubAuthSecret()
  }
}
