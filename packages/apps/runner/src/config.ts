/**
 * Runner configuration — env-first with an optional JSON config file
 * (`SLAYZONE_RUNNER_CONFIG=/path/to/config.json`). Env vars win over the
 * file so operators can override a checked-in config per host.
 *
 * @module runner/config
 */

import { realpathSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { decodeJoinToken } from './join-token'

export const runnerConfigSchema = z.object({
  /** `ws://` or `wss://` hub fleet endpoint. */
  hubUrl: z.string().min(1),
  /** Required for first contact; later runs reconnect with stored credentials. */
  joinToken: z.string().min(1).optional(),
  /** Human-readable runner name shown on the hub. Defaults to the hostname. */
  name: z.string().min(1),
  /** Filesystem roots this runner may operate under (fs./git. commands). */
  allowedRoots: z.array(z.string().min(1)),
  /** Capability tags advertised at enrollment. */
  capabilities: z.array(z.string().min(1)),
  /** sha256 pin of the hub TLS leaf cert (lowercase hex; colons tolerated). */
  pinnedCertSha256: z.string().min(1).optional(),
  /** Override for the credential-store directory (tests, packaging). */
  credentialsDir: z.string().min(1).optional(),
  heartbeatIntervalMs: z.number().int().positive().optional()
})
export type RunnerConfig = z.infer<typeof runnerConfigSchema>

export const ENV_VARS = {
  hubUrl: 'SLAYZONE_HUB_URL',
  joinToken: 'SLAYZONE_JOIN_TOKEN',
  name: 'SLAYZONE_RUNNER_NAME',
  allowedRoots: 'SLAYZONE_RUNNER_ALLOWED_ROOTS',
  capabilities: 'SLAYZONE_RUNNER_CAPABILITIES',
  pinnedCertSha256: 'SLAYZONE_HUB_CERT_SHA256',
  credentialsDir: 'SLAYZONE_RUNNER_CREDENTIALS_DIR',
  heartbeatIntervalMs: 'SLAYZONE_RUNNER_HEARTBEAT_MS',
  configFile: 'SLAYZONE_RUNNER_CONFIG'
} as const

export const DEFAULT_CAPABILITIES = ['pty', 'git', 'fs', 'proc'] as const

/**
 * Resolve `target` to an absolute canonical path, tolerating a
 * not-yet-existing tail (e.g. a worktree directory about to be created).
 *
 * Lexically normalizes `..` first, then `realpath`s the nearest EXISTING
 * ancestor to collapse symlinks (so an attacker cannot symlink out of an
 * allowed root), re-appending the non-existent remainder. This closes both the
 * lexical-`../` traversal hole and the symlinked-ancestor hole.
 */
function realpathBoundary(target: string): string {
  let current = resolve(target)
  const tail: string[] = []
  // Walk up until we hit an existing directory we can canonicalize.
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        // Reached the filesystem root and nothing exists — fall back to the
        // lexically-resolved path (already free of `..` segments).
        return resolve(target)
      }
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * Assert that `candidate` is contained within one of `allowedRoots` and return
 * its canonical absolute path. Throws a clear error on traversal outside every
 * configured root (or when no roots are configured at all).
 *
 * Every fs./git./proc. path argument on the runner MUST pass through this guard
 * before touching the filesystem.
 */
export function assertPathAllowed(candidate: string, allowedRoots: readonly string[]): string {
  if (allowedRoots.length === 0) {
    throw new Error(
      `runner has no allowedRoots configured; refusing filesystem access to '${candidate}'`
    )
  }
  const resolved = realpathBoundary(candidate)
  for (const root of allowedRoots) {
    let realRoot: string
    try {
      realRoot = realpathSync.native(resolve(root))
    } catch {
      // A configured root that does not exist cannot contain anything — skip it.
      continue
    }
    if (resolved === realRoot || resolved.startsWith(realRoot + sep)) {
      return resolved
    }
  }
  throw new Error(
    `path '${candidate}' is outside the runner's allowedRoots [${allowedRoots.join(', ')}]`
  )
}

type Env = Record<string, string | undefined>

function splitList(value: string | undefined, separator: string): string[] | undefined {
  if (value === undefined) return undefined
  const parts = value
    .split(separator)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  return parts
}

function readConfigFile(path: string): Partial<RunnerConfig> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`cannot read runner config file '${path}': ${String(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`runner config file '${path}' is not valid JSON: ${String(err)}`)
  }
  const result = runnerConfigSchema.partial().safeParse(parsed)
  if (!result.success) {
    throw new Error(`runner config file '${path}' is invalid: ${result.error.message}`)
  }
  return result.data
}

/**
 * Assemble the effective config: defaults ← config file ← environment.
 * Throws with a readable message when required fields are missing.
 */
export function loadRunnerConfig(env: Env = process.env): RunnerConfig {
  const fromFile = env[ENV_VARS.configFile] ? readConfigFile(env[ENV_VARS.configFile] as string) : {}

  const heartbeatRaw = env[ENV_VARS.heartbeatIntervalMs]
  const heartbeatFromEnv = heartbeatRaw === undefined ? undefined : Number(heartbeatRaw)
  if (heartbeatFromEnv !== undefined && !Number.isInteger(heartbeatFromEnv)) {
    throw new Error(`${ENV_VARS.heartbeatIntervalMs} must be an integer, got '${heartbeatRaw}'`)
  }

  // A join token is self-sufficient: it embeds the hub's `wss://…/fleet` URL and
  // the cert fingerprint to pin. Decode it and use those as the LOWEST-precedence
  // fallback for hubUrl + pinnedCertSha256, so `SLAYZONE_JOIN_TOKEN=… runner` works
  // with no other config. An explicit hubUrl / pin (file or env) still wins, so an
  // operator can point a token at a different endpoint or override the pin. A
  // malformed token decodes to null → no fallback (schema then reports the missing
  // hubUrl, exactly as before).
  const joinToken = env[ENV_VARS.joinToken] ?? fromFile.joinToken
  const fromToken = joinToken ? decodeJoinToken(joinToken) : null

  const merged = {
    name: hostname(),
    allowedRoots: [] as string[],
    capabilities: [...DEFAULT_CAPABILITIES],
    ...(fromToken
      ? { hubUrl: fromToken.hubUrl, pinnedCertSha256: fromToken.certFingerprint }
      : {}),
    ...fromFile,
    ...(env[ENV_VARS.hubUrl] !== undefined ? { hubUrl: env[ENV_VARS.hubUrl] } : {}),
    ...(env[ENV_VARS.joinToken] !== undefined ? { joinToken: env[ENV_VARS.joinToken] } : {}),
    ...(env[ENV_VARS.name] !== undefined ? { name: env[ENV_VARS.name] } : {}),
    ...(splitList(env[ENV_VARS.allowedRoots], delimiter) !== undefined
      ? { allowedRoots: splitList(env[ENV_VARS.allowedRoots], delimiter) }
      : {}),
    ...(splitList(env[ENV_VARS.capabilities], ',') !== undefined
      ? { capabilities: splitList(env[ENV_VARS.capabilities], ',') }
      : {}),
    ...(env[ENV_VARS.pinnedCertSha256] !== undefined
      ? { pinnedCertSha256: env[ENV_VARS.pinnedCertSha256] }
      : {}),
    ...(env[ENV_VARS.credentialsDir] !== undefined
      ? { credentialsDir: env[ENV_VARS.credentialsDir] }
      : {}),
    ...(heartbeatFromEnv !== undefined ? { heartbeatIntervalMs: heartbeatFromEnv } : {})
  }

  const result = runnerConfigSchema.safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(
      `invalid runner configuration (${issues}). Set ${ENV_VARS.hubUrl} (and ${ENV_VARS.joinToken} for first contact) or provide ${ENV_VARS.configFile}.`
    )
  }

  // Fail-fast on an EXPLICITLY-configured pin (env or config file) against a
  // plaintext ws:// hub: pinning is meaningless without TLS, and silently dropping
  // it would downgrade an operator who asked for pinning to an unpinned connection.
  // A pin that came ONLY from the join token (the auto path) is NOT explicit — it
  // is softly ignored downstream (startRunner) when the resolved url is ws://, so a
  // ws token stays usable for loopback/dev without a hard failure.
  const explicitPin = env[ENV_VARS.pinnedCertSha256] ?? fromFile.pinnedCertSha256
  if (explicitPin !== undefined && urlProtocol(result.data.hubUrl) === 'ws:') {
    throw new Error(
      `${ENV_VARS.pinnedCertSha256} (or config pinnedCertSha256) requires a wss:// hub url; ` +
        `got '${result.data.hubUrl}'. Pinning has no effect without TLS — use a wss:// url or drop the pin.`
    )
  }
  return result.data
}

/** Parse a url's protocol (`ws:` / `wss:` / …), or `null` if malformed. */
function urlProtocol(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}
