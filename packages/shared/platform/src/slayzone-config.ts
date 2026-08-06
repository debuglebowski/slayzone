/**
 * Per-role SlayZone config/state files at the root of a hub or runner install.
 * Each role's own settings split into two files by write frequency:
 *
 *   `<ROOT>/hub.config.json`    — operator-set: address, publicAddress, mode, hubName
 *   `<ROOT>/hub.state.json`     — system-generated: runnerTransportSecret (the hub-auth
 *                                 secret; auto-generated on first boot, never typed in)
 *   `<ROOT>/runner.config.json` — operator-set: joinToken, runnerName, hubUrl,
 *                                 allowedRoots, pinnedCertSha256
 *
 * (Runner credentials — `runner.state.json`, system-generated, rewritten on every
 * reconnect/rotation — are a separate concern owned entirely by
 * `@slayzone/runner-transport`'s `credential-store.ts`, not this module. That
 * package deliberately doesn't depend on `@slayzone/platform` to keep the runner
 * bundle lean, so it isn't re-modeled here.)
 *
 * Symmetric naming on purpose: no bare `hub.json`/`runner.json` anywhere, so
 * there's never a question of which file in the pair a plain name would mean —
 * and no collision with the CLI's own unrelated `cli-hub-target.json` (which
 * hub-config.ts in the CLI package owns; not this module's concern either).
 *
 * Legacy fallback: these used to be one shared `<ROOT>/config.json` file, hub and
 * runner keys mixed together. If a role's new file is absent but a sibling
 * `config.json` exists, the relevant keys are coerced from it instead — read-only,
 * indefinite, never auto-upgraded (no write ever targets `config.json`). Without
 * this, every existing standalone deployment would lose its hub-auth secret or
 * join credentials the moment it upgrades. Mirrors this module's existing
 * tolerance for legacy *keys* (`port`, `publicUrl`), just one level up, for a
 * legacy *file*.
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
 * is exposed as the `@slayzone/platform/slayzone-config` SUBPATH so the runner
 * bundle can import it WITHOUT pulling the platform barrel (which references
 * better-sqlite3 types + the shell/cli-install graph). It depends only on
 * `./dirs` + node builtins, so esbuild bundles just this leaf → the runner stays
 * lean (no better-sqlite3).
 *
 * @module platform/slayzone-config
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getSlayzoneHomeDir } from './dirs'

// Re-exported on this lean subpath so the runner bundle can resolve the ROOT
// anchor without importing the platform barrel (which pulls better-sqlite3).
export { getSlayzoneHomeDir } from './dirs'

/** `<ROOT>/hub.config.json` — operator-set hub keys. Every key optional, a fresh install has no file. */
export interface HubConfig {
  /** The address the hub BINDS for ALL transport — `host[:port]`, no scheme. */
  address?: string
  /** The hub's EXTERNAL address, `host[:port]`, no scheme. Needed only when it differs from `address`. */
  publicAddress?: string
  /** `remote` enforces client auth + TLS + `wss://` join tokens; `local` (default when unset) is the loopback/dev shape. */
  mode?: 'local' | 'remote'
  /** Operator-facing hub name. Defaults to the ROOT directory's basename when unset. */
  hubName?: string
  /** @deprecated Legacy bind port, superseded by `address`. Still READ; never written fresh. */
  port?: number
  /** @deprecated Legacy full public URL, superseded by `publicAddress`. Still READ; never written fresh. */
  publicUrl?: string
}

/** `<ROOT>/hub.state.json` — system-generated hub state. */
export interface HubState {
  /** HMAC secret backing hub-auth (session/cookie signer + runner enroll/api-key credentials). Auto-generated + persisted on first standalone boot if absent. */
  runnerTransportSecret?: string
}

/** `<ROOT>/runner.config.json` — operator-set runner keys. Every key optional, a fresh install has no file. */
export interface RunnerConfig {
  /** First-contact join token for a standalone runner. */
  joinToken?: string
  /** Human-readable runner name. */
  runnerName?: string
  /** Full `ws(s)://…/runners` endpoint a standalone runner dials. */
  hubUrl?: string
  /** Filesystem roots the runner may operate under. Locally-declared, never pushed from the hub. Defaults to `[<ROOT>]` when absent. */
  allowedRoots?: string[]
  /** sha256 pin of the hub TLS leaf cert (lowercase hex). Normally the join token carries the pin instead. */
  pinnedCertSha256?: string
}

/** The dev fallback secret hard-coded in composition.ts. Standalone boots MUST
 *  resolve to something OTHER than this (env / file / generated). Exported so
 *  callers + tests can assert against it. */
export const DEV_HUB_AUTH_SECRET = 'slayzone-dev-runner-secret'

/**
 * Name of the co-located ("local") auto-spawned runner — re-exported so every
 * existing importer of this subpath keeps working.
 */
export { DEFAULT_LOCAL_RUNNER_NAME } from './runner-identity'

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

export function getRunnerConfigFilePath(): string {
  return join(getSlayzoneHomeDir(), 'runner.config.json')
}

/** The legacy shared file's path, for the read-only fallback — never written to by this module. */
function legacyConfigFilePathFor(newFilePath: string): string {
  return join(dirname(newFilePath), 'config.json')
}

function coerceHubConfig(raw: Record<string, unknown>): HubConfig {
  const cfg: HubConfig = {}
  if (typeof raw.address === 'string' && raw.address.length > 0) cfg.address = raw.address
  if (typeof raw.publicAddress === 'string' && raw.publicAddress.length > 0)
    cfg.publicAddress = raw.publicAddress
  // Exact literals only — a near-miss must read as unset, not half-applied.
  if (raw.mode === 'local' || raw.mode === 'remote') cfg.mode = raw.mode
  if (typeof raw.hubName === 'string' && raw.hubName.trim().length > 0) cfg.hubName = raw.hubName.trim()
  // Legacy keys, still read so an existing file keeps booting.
  if (typeof raw.port === 'number' && Number.isInteger(raw.port)) cfg.port = raw.port
  if (typeof raw.publicUrl === 'string' && raw.publicUrl.length > 0) cfg.publicUrl = raw.publicUrl
  return cfg
}

function coerceHubState(raw: Record<string, unknown>): HubState {
  const state: HubState = {}
  if (typeof raw.runnerTransportSecret === 'string' && raw.runnerTransportSecret.length > 0)
    state.runnerTransportSecret = raw.runnerTransportSecret
  return state
}

function coerceRunnerConfig(raw: Record<string, unknown>): RunnerConfig {
  const cfg: RunnerConfig = {}
  if (typeof raw.joinToken === 'string' && raw.joinToken.length > 0) cfg.joinToken = raw.joinToken
  if (typeof raw.runnerName === 'string' && raw.runnerName.length > 0) cfg.runnerName = raw.runnerName
  if (typeof raw.hubUrl === 'string' && raw.hubUrl.length > 0) cfg.hubUrl = raw.hubUrl
  if (Array.isArray(raw.allowedRoots)) {
    const roots = raw.allowedRoots.filter((r): r is string => typeof r === 'string' && r.length > 0)
    if (roots.length > 0) cfg.allowedRoots = roots
  }
  if (typeof raw.pinnedCertSha256 === 'string' && raw.pinnedCertSha256.length > 0)
    cfg.pinnedCertSha256 = raw.pinnedCertSha256
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

/**
 * Load `hub.config.json`. Falls back to coercing hub keys out of a sibling
 * legacy `config.json` when the new file is absent (see module doc).
 */
export function loadHubConfigFile(path: string = getHubConfigFilePath()): HubConfig {
  const raw = readJsonObject(path)
  if (raw) return coerceHubConfig(raw)
  const legacy = readJsonObject(legacyConfigFilePathFor(path))
  return legacy ? coerceHubConfig(legacy) : {}
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

/** Load `hub.state.json`. Falls back to a sibling legacy `config.json`'s `runnerTransportSecret` when absent. */
export function loadHubStateFile(path: string = getHubStateFilePath()): HubState {
  const raw = readJsonObject(path)
  if (raw) return coerceHubState(raw)
  const legacy = readJsonObject(legacyConfigFilePathFor(path))
  return legacy ? coerceHubState(legacy) : {}
}

export function saveHubStateFile(state: HubState, path: string = getHubStateFilePath()): void {
  writeJsonAtomic(path, state)
}

/**
 * Load `runner.config.json`. Falls back to coercing runner keys out of a
 * sibling legacy `config.json` when the new file is absent (see module doc).
 */
export function loadRunnerConfigFile(path: string = getRunnerConfigFilePath()): RunnerConfig {
  const raw = readJsonObject(path)
  if (raw) return coerceRunnerConfig(raw)
  const legacy = readJsonObject(legacyConfigFilePathFor(path))
  return legacy ? coerceRunnerConfig(legacy) : {}
}

export function saveRunnerConfigFile(cfg: RunnerConfig, path: string = getRunnerConfigFilePath()): void {
  writeJsonAtomic(path, cfg)
}

/**
 * Merge `patch` over the on-disk `runner.config.json` and persist (atomic, 0600).
 */
export function updateRunnerConfigFile(
  patch: Partial<RunnerConfig>,
  path: string = getRunnerConfigFilePath()
): RunnerConfig {
  const current = readJsonObject(path)
  const merged: RunnerConfig = current ? coerceRunnerConfig(current) : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v
  }
  saveRunnerConfigFile(merged, path)
  return merged
}

/**
 * Resolve the hub-auth secret for a STANDALONE boot: `hub.state.json`'s
 * `runnerTransportSecret` if present (including via the legacy `config.json`
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
  if (existing.runnerTransportSecret) return existing.runnerTransportSecret

  const candidate = randomBytes(32).toString('hex')
  const merged: HubState = { ...existing, runnerTransportSecret: candidate }

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
  if (afterRaceState.runnerTransportSecret) return afterRaceState.runnerTransportSecret
  const finalState = updateHubStateFile({ runnerTransportSecret: candidate }, path)
  return finalState.runnerTransportSecret ?? candidate
}

function updateHubStateFile(patch: Partial<HubState>, path: string = getHubStateFilePath()): HubState {
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
 * writing `hub.config.json` or `runner.config.json` (the caller already
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
