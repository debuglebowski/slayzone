/**
 * Per-role SlayZone config/state files at the root of a hub or computer install.
 * Each role's own settings split into two files by write frequency:
 *
 *   `<ROOT>/hub.config.json`    — operator-set: listenAddress, publicAddress, hubName,
 *                                 and the per-hub switches (requireLogin, enablePassword,
 *                                 enableSso, ssoTenantId, ssoClientId, enableProcesses,
 *                                 enableIntegrations — booleans; secrets are env only)
 *   `<ROOT>/hub.state.json`     — system-generated: computerTransportSecret (the hub-auth
 *                                 secret; auto-generated on first boot, never typed in,
 *                                 by a hub only this machine reaches — a reachable hub
 *                                 takes it from env and never writes this file, T-11)
 *   `<ROOT>/computer.config.json` — operator-set: joinToken, computerName, hubUrl,
 *                                 allowedRoots
 *
 * (Computer credentials — `computer.state.json`, system-generated, rewritten on every
 * reconnect/rotation — are a separate concern owned entirely by
 * `@slayzone/computer-transport`'s `credential-store.ts`, not this module. That
 * package deliberately doesn't depend on `@slayzone/platform` to keep the computer
 * bundle lean, so it isn't re-modeled here.)
 *
 * Symmetric naming on purpose: no bare `hub.json`/`computer.json` anywhere, so
 * there's never a question of which file in the pair a plain name would mean —
 * and no collision with the CLI's own unrelated `cli-hub-target.json` (which
 * hub-config.ts in the CLI package owns; not this module's concern either).
 *
 * Legacy fallback: these used to be one shared `<ROOT>/config.json` file, hub and
 * computer keys mixed together. If a role's new file is absent but a sibling
 * `config.json` exists, the relevant keys are coerced from it instead — read-only,
 * indefinite, never auto-upgraded (no write ever targets `config.json`). Without
 * this, every existing standalone deployment would lose its hub-auth secret or
 * join credentials the moment it upgrades.
 *
 * Precedence everywhere: env var > file > generated/default. The file is the
 * BASE — env can still override it (e.g. CI). Only keys that are actually set
 * are persisted.
 *
 * SUPERVISED mode (Electron host, `SLAYZONE_SUPERVISED=1`) must NOT touch any of
 * these files at all — the callers gate reads/writes on `!SUPERVISED`. Nothing in
 * this module reads `SLAYZONE_SUPERVISED`; it is a pure file reader/writer.
 *
 * Home dir honors `SLAYZONE_ROOT` (see getSlayzoneHomeDir) for E2E/test
 * sandboxing, so a test can redirect every file here to a temp dir.
 *
 * This module lives in @slayzone/platform (where getSlayzoneHomeDir lives) and
 * is exposed as the `@slayzone/platform/slayzone-config` SUBPATH so the computer
 * bundle can import it WITHOUT pulling the platform barrel (which references
 * better-sqlite3 types + the shell/cli-install graph). It depends only on
 * `./dirs` + node builtins, so esbuild bundles just this leaf → the computer stays
 * lean (no better-sqlite3).
 *
 * @module platform/slayzone-config
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getSlayzoneHomeDir } from './dirs'

// Re-exported on this lean subpath so the computer bundle can resolve the ROOT
// anchor without importing the platform barrel (which pulls better-sqlite3).
export { getSlayzoneHomeDir } from './dirs'

/** `<ROOT>/hub.config.json` — operator-set hub keys. Every key optional, a fresh install has no file. */
export interface HubConfig {
  /** The address the hub LISTENS on for ALL transport — `host[:port]`, no scheme. */
  listenAddress?: string
  /** How OTHER machines reach the hub, `host[:port]`, no scheme. Set it whenever the hub is reachable off-box (rule B3). */
  publicAddress?: string
  /** Operator-facing hub name. Defaults to the ROOT directory's basename when unset. */
  hubName?: string
  /** Every client must sign in. Default off (the desktop app's hub). */
  requireLogin?: boolean
  /** Email + password sign-in. Default on. */
  enablePassword?: boolean
  /** Entra OIDC sign-in. Default off; needs `ssoTenantId`, `ssoClientId` and the env-only certificate + key paths (`SLAYZONE_HUB_SSO_CERT_PATH` / `_KEY_PATH`). */
  enableSso?: boolean
  /** Entra tenant id. */
  ssoTenantId?: string
  /** Entra app registration (client) id. */
  ssoClientId?: string
  /** Hub-local processes + automation commands. Default on. */
  enableProcesses?: boolean
  /** Linear / GitHub connect + sync. Default on. */
  enableIntegrations?: boolean
}

/** The boolean switch keys of {@link HubConfig}, in file order. */
export const HUB_CONFIG_SWITCH_KEYS = [
  'requireLogin',
  'enablePassword',
  'enableSso',
  'enableProcesses',
  'enableIntegrations'
] as const satisfies ReadonlyArray<keyof HubConfig>

/** Old `hub.config.json` keys that no longer mean anything — boot refuses them (rule B5). */
const RENAMED_HUB_CONFIG_KEYS: Record<string, string> = {
  address: 'listenAddress',
  port: 'listenAddress (host:port)',
  publicUrl: 'publicAddress (host[:port], no scheme)'
}

/** A problem found in a `hub.config.json` that must stop a hub from booting. */
export interface HubConfigProblem {
  /** The offending key. */
  key: string
  /** Human-readable, names the key and what to do. */
  message: string
}

/** `<ROOT>/hub.state.json` — system-generated hub state. */
export interface HubState {
  /** HMAC secret backing hub-auth (session/cookie signer + computer enroll/api-key credentials). Auto-generated + persisted on first standalone boot if absent. */
  computerTransportSecret?: string
}

/** `<ROOT>/computer.config.json` — operator-set computer keys. Every key optional, a fresh install has no file. */
export interface ComputerConfig {
  /** First-contact join token for a standalone computer. */
  joinToken?: string
  /** Human-readable computer name. */
  computerName?: string
  /** Full `ws(s)://…/computers` endpoint a standalone computer dials. */
  hubUrl?: string
  /** Additional hubs this computer serves. See computer/config.ts. */
  hubUrls?: string[]
  /** Filesystem roots the computer may operate under. Locally-declared, never pushed from the hub. Defaults to `[<ROOT>]` when absent. */
  allowedRoots?: string[]
}

/**
 * `computer.config.json` keys an older release read and this one IGNORES (never
 * coerced into {@link ComputerConfig}). `pinnedCertSha256` pinned the certificate an
 * older hub served itself; the hub no longer does TLS, a front end does, and its
 * certificate is verified the normal way. Listed so the computer can say it ignores
 * one, rather than a stale key being dropped silently.
 */
export const IGNORED_COMPUTER_CONFIG_KEYS = ['pinnedCertSha256'] as const

/** The dev fallback secret hard-coded in composition.ts. Standalone boots MUST
 *  resolve to something OTHER than this (env / file / generated). Exported so
 *  callers + tests can assert against it. */
export const DEV_HUB_AUTH_SECRET = 'slayzone-dev-computer-secret'

/**
 * Name of the co-located ("local") auto-spawned computer — re-exported so every
 * existing importer of this subpath keeps working.
 */
export { DEFAULT_LOCAL_COMPUTER_NAME } from './computer-identity'

/** Name reported by the desktop app's supervised sidecar. Fixed rather than
 *  ROOT-derived: the app's ROOT is a platform state dir whose basename is
 *  meaningless to an operator, and `slay hub ls` needs one predictable label for
 *  "the hub inside the app". */
export const SUPERVISED_HUB_NAME = 'app'

/**
 * Resolve this hub's operator-facing name: `SLAYZONE_HUB_NAME` env >
 * `hub.config.json`'s `hubName` > `basename(ROOT)` — or the fixed
 * {@link SUPERVISED_HUB_NAME} when supervised.
 *
 * A blank/whitespace env value counts as UNSET, so a stray `SLAYZONE_HUB_NAME=`
 * cannot produce a nameless hub that `slay hub stop` could never address.
 *
 * Reads the config file only when it needs to (env unset, not supervised), so a
 * supervised boot still never touches it.
 */
export function resolveHubName(): string {
  const fromEnv = process.env.SLAYZONE_HUB_NAME?.trim()
  if (fromEnv) return fromEnv
  if (process.env.SLAYZONE_SUPERVISED === '1') return SUPERVISED_HUB_NAME
  const fromFile = loadHubConfigFile().hubName?.trim()
  if (fromFile) return fromFile
  // basename('/') is '' on posix — fall back rather than return a nameless hub.
  return basename(getSlayzoneHomeDir()) || 'hub'
}

export function getHubConfigFilePath(): string {
  return join(getSlayzoneHomeDir(), 'hub.config.json')
}

export function getHubStateFilePath(): string {
  return join(getSlayzoneHomeDir(), 'hub.state.json')
}

export function getComputerConfigFilePath(): string {
  return join(getSlayzoneHomeDir(), 'computer.config.json')
}

/** The legacy shared file's path, for the read-only fallback — never written to by this module. */
function legacyConfigFilePathFor(newFilePath: string): string {
  return join(dirname(newFilePath), 'config.json')
}

function coerceHubConfig(raw: Record<string, unknown>): HubConfig {
  const cfg: HubConfig = {}
  if (typeof raw.listenAddress === 'string' && raw.listenAddress.length > 0)
    cfg.listenAddress = raw.listenAddress
  if (typeof raw.publicAddress === 'string' && raw.publicAddress.length > 0)
    cfg.publicAddress = raw.publicAddress
  if (typeof raw.hubName === 'string' && raw.hubName.trim().length > 0)
    cfg.hubName = raw.hubName.trim()
  // Booleans only: a near-miss ("true", 1) is reported by diagnoseHubConfig and
  // refuses boot — it must never read as unset, because a switch that silently
  // fell back to its default would fail open.
  for (const key of HUB_CONFIG_SWITCH_KEYS) {
    if (typeof raw[key] === 'boolean') cfg[key] = raw[key]
  }
  if (typeof raw.ssoTenantId === 'string' && raw.ssoTenantId.trim().length > 0)
    cfg.ssoTenantId = raw.ssoTenantId.trim()
  if (typeof raw.ssoClientId === 'string' && raw.ssoClientId.trim().length > 0)
    cfg.ssoClientId = raw.ssoClientId.trim()
  // `mode` (the retired SLAYZONE_MODE key) is deliberately NOT read: it is ignored.
  return cfg
}

/**
 * Everything in a raw `hub.config.json` that must refuse boot:
 *   - the renamed keys `address`, `port`, `publicUrl` (rule B5) — honoring them
 *     silently would leave the hub listening somewhere the operator did not intend,
 *   - a switch key holding anything but a boolean (rule B4).
 * `mode` is not a problem; it is ignored.
 */
export function diagnoseHubConfig(raw: Record<string, unknown>): HubConfigProblem[] {
  const problems: HubConfigProblem[] = []
  for (const [oldKey, newKey] of Object.entries(RENAMED_HUB_CONFIG_KEYS)) {
    if (raw[oldKey] !== undefined) {
      problems.push({
        key: oldKey,
        message: `'${oldKey}' was renamed to '${newKey}'`
      })
    }
  }
  for (const key of HUB_CONFIG_SWITCH_KEYS) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
      problems.push({
        key,
        message: `'${key}' must be true or false, got ${JSON.stringify(raw[key])}`
      })
    }
  }
  return problems
}

function coerceHubState(raw: Record<string, unknown>): HubState {
  const state: HubState = {}
  if (typeof raw.computerTransportSecret === 'string' && raw.computerTransportSecret.length > 0)
    state.computerTransportSecret = raw.computerTransportSecret
  return state
}

function coerceComputerConfig(raw: Record<string, unknown>): ComputerConfig {
  const cfg: ComputerConfig = {}
  if (typeof raw.joinToken === 'string' && raw.joinToken.length > 0) cfg.joinToken = raw.joinToken
  if (typeof raw.computerName === 'string' && raw.computerName.length > 0)
    cfg.computerName = raw.computerName
  if (typeof raw.hubUrl === 'string' && raw.hubUrl.length > 0) cfg.hubUrl = raw.hubUrl
  if (Array.isArray(raw.allowedRoots)) {
    const roots = raw.allowedRoots.filter((r): r is string => typeof r === 'string' && r.length > 0)
    if (roots.length > 0) cfg.allowedRoots = roots
  }
  return cfg
}

/** Read + parse a JSON file. A missing/corrupt/non-object file resolves to `null` (never throws) — the caller decides the empty-result shape. */
export function readJsonObject(path: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    process.stderr.write(
      `[slayzone-config] cannot read ${path}: ${err instanceof Error ? err.message : String(err)} — using empty config\n`
    )
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(
      `[slayzone-config] ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)} — using empty config\n`
    )
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(`[slayzone-config] ${path} is not a JSON object — using empty config\n`)
    return null
  }
  return parsed as Record<string, unknown>
}

/**
 * Atomically write a JSON object. Creates the parent dir 0700 and writes the
 * file 0600 (tmp-sibling + rename, so a crash never leaves a half-written
 * file). Shared by all three file kinds below — don't fork this four ways.
 *
 * WINDOWS CAVEAT: the mode (0700/0600) is a POSIX permission bitmask and is a
 * no-op on Windows — NTFS ACLs are not touched. The atomic tmp+rename still holds.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  try {
    renameSync(tmpPath, path)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

/** The raw object backing the hub config: the new file, else the legacy shared `config.json`. */
function readHubConfigRaw(path: string): Record<string, unknown> | null {
  return readJsonObject(path) ?? readJsonObject(legacyConfigFilePathFor(path))
}

/**
 * Load `hub.config.json`. Falls back to coercing hub keys out of a sibling
 * legacy `config.json` when the new file is absent (see module doc).
 */
export function loadHubConfigFile(path: string = getHubConfigFilePath()): HubConfig {
  const raw = readHubConfigRaw(path)
  return raw ? coerceHubConfig(raw) : {}
}

/**
 * The problems in the hub config that must refuse boot (see {@link diagnoseHubConfig}),
 * read from the same file {@link loadHubConfigFile} reads. Empty when there is no file.
 */
export function loadHubConfigProblems(path: string = getHubConfigFilePath()): HubConfigProblem[] {
  const raw = readHubConfigRaw(path)
  return raw ? diagnoseHubConfig(raw) : []
}

export function saveHubConfigFile(cfg: HubConfig, path: string = getHubConfigFilePath()): void {
  writeJsonAtomic(path, cfg)
}

/**
 * Merge `patch` over the on-disk `hub.config.json` and persist (atomic, 0600).
 * Reads the current file first so a focused single-key update never clobbers
 * other keys. Undefined patch values are ignored (they don't erase existing keys).
 */
export function updateHubConfigFile(
  patch: Partial<HubConfig>,
  path: string = getHubConfigFilePath()
): HubConfig {
  const current = readJsonObject(path)
  const merged: HubConfig = current ? coerceHubConfig(current) : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v
  }
  saveHubConfigFile(merged, path)
  return merged
}

/** Load `hub.state.json`. Falls back to a sibling legacy `config.json`'s `computerTransportSecret` when absent. */
export function loadHubStateFile(path: string = getHubStateFilePath()): HubState {
  const raw = readJsonObject(path)
  if (raw) return coerceHubState(raw)
  const legacy = readJsonObject(legacyConfigFilePathFor(path))
  return legacy ? coerceHubState(legacy) : {}
}

/**
 * {@link loadHubStateFile}'s secret plus the file it came from — read-only. For a hub
 * other machines can reach, which takes its secret from env and only compares it with
 * one it generated earlier (boot rule B17, T-11); it never writes either file.
 */
export function readKeptHubAuthSecret(path: string = getHubStateFilePath()): {
  secret: string | undefined
  path: string
} {
  const raw = readJsonObject(path)
  if (raw) return { secret: coerceHubState(raw).computerTransportSecret, path }
  const legacyPath = legacyConfigFilePathFor(path)
  const legacy = readJsonObject(legacyPath)
  return legacy
    ? { secret: coerceHubState(legacy).computerTransportSecret, path: legacyPath }
    : { secret: undefined, path }
}

export function saveHubStateFile(state: HubState, path: string = getHubStateFilePath()): void {
  writeJsonAtomic(path, state)
}

/**
 * Load `computer.config.json`. Falls back to coercing computer keys out of a
 * sibling legacy `config.json` when the new file is absent (see module doc).
 */
export function loadComputerConfigFile(path: string = getComputerConfigFilePath()): ComputerConfig {
  const raw = readJsonObject(path)
  if (raw) return coerceComputerConfig(raw)
  const legacy = readJsonObject(legacyConfigFilePathFor(path))
  return legacy ? coerceComputerConfig(legacy) : {}
}

/**
 * Which {@link IGNORED_COMPUTER_CONFIG_KEYS} the computer config still sets — read
 * from the same file {@link loadComputerConfigFile} reads (the legacy `config.json`
 * when the new file is absent). Empty for a missing/corrupt file.
 */
export function ignoredComputerConfigKeys(path: string = getComputerConfigFilePath()): string[] {
  const raw = readJsonObject(path) ?? readJsonObject(legacyConfigFilePathFor(path))
  if (!raw) return []
  return IGNORED_COMPUTER_CONFIG_KEYS.filter((key) => raw[key] !== undefined)
}

export function saveComputerConfigFile(
  cfg: ComputerConfig,
  path: string = getComputerConfigFilePath()
): void {
  writeJsonAtomic(path, cfg)
}

/**
 * Merge `patch` over the on-disk `computer.config.json` and persist (atomic, 0600).
 */
export function updateComputerConfigFile(
  patch: Partial<ComputerConfig>,
  path: string = getComputerConfigFilePath()
): ComputerConfig {
  const current = readJsonObject(path)
  const merged: ComputerConfig = current ? coerceComputerConfig(current) : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v
  }
  saveComputerConfigFile(merged, path)
  return merged
}

/**
 * Resolve the hub-auth secret for a STANDALONE boot: `hub.state.json`'s
 * `computerTransportSecret` if present (including via the legacy `config.json`
 * fallback), else generate a fresh 256-bit hex secret and PERSIST it into
 * `hub.state.json` (0600) so it is stable across reboots. Never returns the
 * shared dev constant. The caller layers env on top (env > this).
 *
 * Idempotent + stable: a second call reads back the persisted secret and
 * returns the identical value (no re-generation).
 *
 * CONCURRENCY: two hubs booting at once against a FRESH `hub.state.json` must
 * NOT generate two different secrets (the loser's minted tokens would be
 * unverifiable). Closed with an atomic create-if-absent (`wx` flag): only ONE
 * process can create the file, and every other boot re-reads the winner's
 * secret. The rare residual case (a `hub.state.json` that pre-exists WITHOUT a
 * secret, hit by two boots simultaneously — not a real shape, since this file
 * only ever holds this one key) falls through to a read-modify-write merge.
 */
export function ensureHubAuthSecret(path: string = getHubStateFilePath()): string {
  const existing = loadHubStateFile(path)
  if (existing.computerTransportSecret) return existing.computerTransportSecret

  const candidate = randomBytes(32).toString('hex')
  const merged: HubState = { ...existing, computerTransportSecret: candidate }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return candidate
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  // The file exists now — either a concurrent boot just created it (re-read →
  // its secret, convergence) or a hand-authored partial file pre-existed
  // without a secret (re-read has none → merge candidate in).
  const afterRace = readJsonObject(path)
  const afterRaceState = afterRace ? coerceHubState(afterRace) : {}
  if (afterRaceState.computerTransportSecret) return afterRaceState.computerTransportSecret
  const finalState = updateHubStateFile({ computerTransportSecret: candidate }, path)
  return finalState.computerTransportSecret ?? candidate
}

function updateHubStateFile(
  patch: Partial<HubState>,
  path: string = getHubStateFilePath()
): HubState {
  const current = readJsonObject(path)
  const merged: HubState = current ? coerceHubState(current) : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v
  }
  saveHubStateFile(merged, path)
  return merged
}

/**
 * Generic merge-and-persist for a flat JSON object at an arbitrary path —
 * used by `config-prompt.ts`, which doesn't know at write time whether it's
 * writing `hub.config.json` or `computer.config.json` (the caller already
 * decided which fields/path to pass; this just merges + writes atomically,
 * with no role-specific coercion). Not for use outside that one caller —
 * prefer the typed `update*File` functions above when the shape is known.
 */
export function updateJsonFile(patch: Record<string, unknown>, path: string): void {
  const current = readJsonObject(path) ?? {}
  const merged: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) merged[k] = v
  }
  writeJsonAtomic(path, merged)
}
