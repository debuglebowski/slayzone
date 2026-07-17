/**
 * Shared SlayZone config file — a SINGLE JSON document at
 * `~/.slayzone/config.json` (`join(getSlayzoneHomeDir(), 'config.json')`) read
 * by BOTH the standalone hub and the standalone runner. Each binary reads only
 * the keys it cares about (hub: runnersEnabled/runnerTransportSecret/dbPath/port/runnerTransportPort/
 * publicUrl; runner: joinToken/runnerName/hubUrl).
 *
 * Precedence everywhere: env var > config.json > generated/default. The file is
 * the BASE — env can still override it (e.g. CI). Only keys that are actually
 * set are persisted; derived state (the resolved runner listener port) stays in
 * the DB (`settings.runner_transport_port`) and is NEVER written here.
 *
 * SUPERVISED mode (Electron host, `SLAYZONE_SUPERVISED=1`) must NOT touch this
 * file at all — the callers gate reads/writes on `!SUPERVISED`. Nothing in this
 * module reads `SLAYZONE_SUPERVISED`; it is a pure file reader/writer.
 *
 * Home dir honors `SLAYZONE_HOME_DIR` (see getSlayzoneHomeDir) for E2E/test
 * sandboxing, so a test can redirect the whole config file to a temp dir.
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
import { dirname, join } from 'node:path'
import { getSlayzoneHomeDir } from './dirs'

/**
 * The superset of keys the shared config file may carry. Hub reads the hub keys,
 * runner reads the runner keys; unknown keys are preserved on write (merge) but
 * ignored on read. Every key is optional — a fresh install has no config file.
 */
export interface SlayzoneConfig {
  // --- hub keys ---
  /** Enable runner mode (equivalent to `SLAYZONE_RUNNERS_ENABLED=1`). */
  runnersEnabled?: boolean
  /** HMAC secret backing hub-auth + per-task token mint/verify. Auto-generated
   *  + persisted on first standalone boot if absent (see ensureRunnerTransportSecret). */
  runnerTransportSecret?: string
  /** Absolute SQLite path (`SLAYZONE_DB_PATH` default). */
  dbPath?: string
  /** tRPC/HTTP listen port (`SLAYZONE_PORT`). */
  port?: number
  /** Runner `/runners` https listener port (`SLAYZONE_RUNNER_TRANSPORT_PORT`). */
  runnerTransportPort?: number
  /** Public hub base URL advertised to remote runners (`SLAYZONE_HUB_PUBLIC_URL`). */
  publicUrl?: string
  // --- runner keys ---
  /** First-contact join token for a standalone runner (`SLAYZONE_JOIN_TOKEN`). */
  joinToken?: string
  /** Human-readable runner name (`SLAYZONE_RUNNER_NAME`). */
  runnerName?: string
  /** `ws(s)://` hub runner endpoint a standalone runner dials (`SLAYZONE_HUB_URL`). */
  hubUrl?: string
}

/** The dev fallback secret hard-coded in composition.ts. Standalone boots MUST
 *  resolve to something OTHER than this (env / config / generated). Exported so
 *  callers + tests can assert against it. */
export const DEV_RUNNER_TRANSPORT_SECRET = 'slayzone-dev-runner-secret'

/** Absolute path to the shared config file (`<home>/config.json`). Honors
 *  SLAYZONE_HOME_DIR via getSlayzoneHomeDir. */
export function getSlayzoneConfigPath(): string {
  return join(getSlayzoneHomeDir(), 'config.json')
}

/** Coerce one raw JSON value into a typed config key, dropping wrong-typed
 *  values rather than throwing (a partially-corrupt file must not brick boot). */
function coerce(raw: Record<string, unknown>): SlayzoneConfig {
  const cfg: SlayzoneConfig = {}
  if (typeof raw.runnersEnabled === 'boolean') cfg.runnersEnabled = raw.runnersEnabled
  if (typeof raw.runnerTransportSecret === 'string' && raw.runnerTransportSecret.length > 0)
    cfg.runnerTransportSecret = raw.runnerTransportSecret
  if (typeof raw.dbPath === 'string' && raw.dbPath.length > 0) cfg.dbPath = raw.dbPath
  if (typeof raw.port === 'number' && Number.isInteger(raw.port)) cfg.port = raw.port
  if (typeof raw.runnerTransportPort === 'number' && Number.isInteger(raw.runnerTransportPort))
    cfg.runnerTransportPort = raw.runnerTransportPort
  if (typeof raw.publicUrl === 'string' && raw.publicUrl.length > 0) cfg.publicUrl = raw.publicUrl
  if (typeof raw.joinToken === 'string' && raw.joinToken.length > 0) cfg.joinToken = raw.joinToken
  if (typeof raw.runnerName === 'string' && raw.runnerName.length > 0)
    cfg.runnerName = raw.runnerName
  if (typeof raw.hubUrl === 'string' && raw.hubUrl.length > 0) cfg.hubUrl = raw.hubUrl
  return cfg
}

/**
 * Read + parse the shared config file. A missing file OR a corrupt/non-object
 * file resolves to `{}` (a corrupt file additionally warns to stderr) — it never
 * throws, so a hand-edited-broken config can't brick a boot. Only well-typed
 * keys survive coercion.
 *
 * `configPath` defaults to getSlayzoneConfigPath(); pass an explicit path to
 * read a specific file (tests).
 */
export function loadSlayzoneConfig(configPath: string = getSlayzoneConfigPath()): SlayzoneConfig {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (err) {
    // ENOENT (no file yet) is the normal fresh-install path → empty config.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    process.stderr.write(
      `[slayzone-config] cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)} — using empty config\n`
    )
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(
      `[slayzone-config] ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)} — using empty config\n`
    )
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(`[slayzone-config] ${configPath} is not a JSON object — using empty config\n`)
    return {}
  }
  return coerce(parsed as Record<string, unknown>)
}

/**
 * Atomically write the shared config file. Creates the home dir 0700 and writes
 * the file 0600 (tmp-sibling + rename, so a crash never leaves a half-written
 * file), mirroring runner's credential-store. Only the passed keys are written —
 * pass the FULL desired config (callers usually go through updateSlayzoneConfig,
 * which merges over the on-disk base).
 *
 * WINDOWS CAVEAT: the `mode` (0700/0600) is a POSIX permission bitmask and is a
 * no-op on Windows — NTFS ACLs are not touched. The atomic tmp+rename still
 * holds; only the perm hardening is POSIX-only (same limitation as the runner
 * credential-store).
 */
export function saveSlayzoneConfig(
  cfg: SlayzoneConfig,
  configPath: string = getSlayzoneConfigPath()
): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  try {
    renameSync(tmpPath, configPath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

/**
 * Merge `patch` over the on-disk config and persist the result (atomic, 0600).
 * Reads the current file first so a focused single-key update (e.g. persisting a
 * freshly generated runnerTransportSecret) never clobbers other keys. Returns the merged
 * config. Undefined patch values are ignored (they don't erase existing keys).
 */
export function updateSlayzoneConfig(
  patch: Partial<SlayzoneConfig>,
  configPath: string = getSlayzoneConfigPath()
): SlayzoneConfig {
  const current = loadSlayzoneConfig(configPath)
  const merged: SlayzoneConfig = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v
  }
  saveSlayzoneConfig(merged, configPath)
  return merged
}

/**
 * Resolve the runner secret for a STANDALONE boot: config.json `runnerTransportSecret` if
 * present, else generate a fresh 256-bit hex secret and PERSIST it into the
 * config file (0600) so it is stable across reboots. Never returns the shared
 * dev constant. The caller layers env on top (env > this) — see the hub's
 * standalone-config resolve step.
 *
 * Idempotent + stable: a second call reads back the persisted secret and returns
 * the identical value (no re-generation).
 *
 * CONCURRENCY: two hubs booting at once against a FRESH config.json must NOT
 * generate two different secrets (the loser's minted tokens would be
 * unverifiable). The dominant race — no config.json yet — is closed with an
 * atomic create-if-absent (`wx` flag): only ONE process can create the file, and
 * every other boot re-reads the winner's secret. So all boots converge on ONE
 * secret. The rare residual case (a config.json that pre-exists WITH other keys
 * but WITHOUT a secret, hit by two boots simultaneously) falls through to a
 * read-modify-write merge — last-write-wins there, but that requires a
 * hand-authored partial config raced by two hubs, which is not a real
 * deployment shape (a single hub per host is the norm).
 */
export function ensureRunnerTransportSecret(configPath: string = getSlayzoneConfigPath()): string {
  const existing = loadSlayzoneConfig(configPath)
  if (existing.runnerTransportSecret) return existing.runnerTransportSecret

  const candidate = randomBytes(32).toString('hex')
  const merged: SlayzoneConfig = { ...existing, runnerTransportSecret: candidate }

  // Atomic create-if-absent: `wx` fails with EEXIST if the file already exists,
  // so only one concurrent fresh boot wins the create. dir 0700 / file 0600
  // mirror saveSlayzoneConfig (POSIX; no-op on Windows — see that caveat).
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return candidate
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  // The file exists now. Either a concurrent boot just created it (re-read →
  // its secret, convergence) or it pre-existed with other keys but no secret
  // (re-read has none → merge our candidate in, preserving those keys).
  const afterRace = loadSlayzoneConfig(configPath)
  if (afterRace.runnerTransportSecret) return afterRace.runnerTransportSecret
  const finalCfg = updateSlayzoneConfig({ runnerTransportSecret: candidate }, configPath)
  return finalCfg.runnerTransportSecret ?? candidate
}
