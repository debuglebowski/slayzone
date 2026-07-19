/**
 * Runner configuration — env-first, layered over the single shared config file
 * at `<ROOT>/config.json` (see @slayzone/platform/slayzone-config). Precedence:
 *
 *   env var  >  <ROOT>/config.json  >  default
 *
 * (plus the join-token embedded hubUrl/cert as the lowest fallback). Env still
 * wins so operators / the supervised host can override per boot. There is no
 * separate `SLAYZONE_RUNNER_CONFIG` path-pointing knob — one derived config file.
 *
 * @module runner/config
 */

import { realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { loadSlayzoneConfig, type SlayzoneConfig } from '@slayzone/platform/slayzone-config'
import { decodeJoinToken } from './join-token'

export const runnerConfigSchema = z.object({
  /** `ws://` or `wss://` hub runner endpoint. */
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
  credentialsDir: z.string().min(1).optional()
})
export type RunnerConfig = z.infer<typeof runnerConfigSchema>

export const ENV_VARS = {
  hubUrl: 'SLAYZONE_HUB_URL',
  joinToken: 'SLAYZONE_JOIN_TOKEN',
  // name + allowedRoots: the Electron host injects these into its supervised
  // local runner (see app main startLocalRunnerWithAutoEnroll). Kept as the
  // supervised channel; for a STANDALONE runner name defaults to hostname and
  // allowedRoots come from <ROOT>/config.json (+ the ROOT default in bin.ts).
  name: 'SLAYZONE_RUNNER_NAME',
  allowedRoots: 'SLAYZONE_RUNNER_ALLOWED_ROOTS',
  pinnedCertSha256: 'SLAYZONE_HUB_CERT_SHA256',
  credentialsDir: 'SLAYZONE_RUNNER_CREDENTIALS_DIR'
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
  return value
    .split(separator)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/**
 * Map the shared `<ROOT>/config.json` onto the runner's config shape. This is
 * the SINGLE config file for a standalone runner — the former
 * `SLAYZONE_RUNNER_CONFIG` env var (a second path-pointing knob at an arbitrary
 * file) is gone; there is one derived config at `<ROOT>/config.json`.
 */
function fromSharedConfig(shared: SlayzoneConfig): Partial<RunnerConfig> {
  const out: Partial<RunnerConfig> = {}
  if (shared.hubUrl !== undefined) out.hubUrl = shared.hubUrl
  if (shared.joinToken !== undefined) out.joinToken = shared.joinToken
  if (shared.runnerName !== undefined) out.name = shared.runnerName
  // The FS path-jail — locally-declared only, never sourced from hub-pushed data.
  if (shared.allowedRoots !== undefined) out.allowedRoots = shared.allowedRoots
  if (shared.pinnedCertSha256 !== undefined) out.pinnedCertSha256 = shared.pinnedCertSha256
  if (shared.credentialsDir !== undefined) out.credentialsDir = shared.credentialsDir
  return out
}

/**
 * Assemble the effective config. Precedence (low→high):
 *   defaults ← <ROOT>/config.json ← environment
 * (with the join-token embedded hubUrl/cert as the lowest fallback). Throws with
 * a readable message when required fields are missing.
 *
 * `shared` defaults to reading `<ROOT>/config.json` ONLY for a STANDALONE
 * runner using the real `process.env`. It is skipped ({}) when:
 *   - a test passes its own `env` object (hermetic — never touch the dev's real
 *     config file), or
 *   - `SLAYZONE_SUPERVISED=1` — the app-spawned local runner
 *     (startLocalRunnerWithAutoEnroll passes `{...process.env}`, which carries
 *     SUPERVISED=1). Mirrors the hub's supervised no-op: the Electron host
 *     supplies the runner's env in full (SLAYZONE_HUB_URL / SLAYZONE_JOIN_TOKEN /
 *     SLAYZONE_RUNNER_NAME), so the shared file must not leak into it. Keeps the
 *     supervised runner boot byte-identical to pre-config behavior.
 * Callers can also pass an explicit shared config to test the layering.
 */
export function loadRunnerConfig(
  env: Env = process.env,
  shared: SlayzoneConfig = env === process.env && env.SLAYZONE_SUPERVISED !== '1'
    ? loadSlayzoneConfig()
    : {}
): RunnerConfig {
  const fromShared = fromSharedConfig(shared)

  // A join token is self-sufficient: it embeds the hub's `wss://…/runners` URL and
  // the cert fingerprint to pin. Decode it and use those as the LOWEST-precedence
  // fallback for hubUrl + pinnedCertSha256, so `SLAYZONE_JOIN_TOKEN=… runner` works
  // with no other config. An explicit hubUrl / pin (file or env) still wins, so an
  // operator can point a token at a different endpoint or override the pin. A
  // malformed token decodes to null → no fallback (schema then reports the missing
  // hubUrl, exactly as before).
  const joinToken = env[ENV_VARS.joinToken] ?? fromShared.joinToken
  const fromToken = joinToken ? decodeJoinToken(joinToken) : null

  const merged = {
    name: hostname(),
    allowedRoots: [] as string[],
    capabilities: [...DEFAULT_CAPABILITIES],
    ...(fromToken
      ? { hubUrl: fromToken.hubUrl, pinnedCertSha256: fromToken.certFingerprint }
      : {}),
    // <ROOT>/config.json — base under env (spread after). The single config file.
    ...fromShared,
    ...(env[ENV_VARS.hubUrl] !== undefined ? { hubUrl: env[ENV_VARS.hubUrl] } : {}),
    ...(env[ENV_VARS.joinToken] !== undefined ? { joinToken: env[ENV_VARS.joinToken] } : {}),
    ...(env[ENV_VARS.name] !== undefined ? { name: env[ENV_VARS.name] } : {}),
    // allowedRoots env read is the SUPERVISED injection channel (host passes the
    // path-jail); standalone gets it from config.json / the ROOT default.
    ...(splitList(env[ENV_VARS.allowedRoots], delimiter) !== undefined
      ? { allowedRoots: splitList(env[ENV_VARS.allowedRoots], delimiter) }
      : {}),
    ...(env[ENV_VARS.pinnedCertSha256] !== undefined
      ? { pinnedCertSha256: env[ENV_VARS.pinnedCertSha256] }
      : {}),
    ...(env[ENV_VARS.credentialsDir] !== undefined
      ? { credentialsDir: env[ENV_VARS.credentialsDir] }
      : {})
  }

  const result = runnerConfigSchema.safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(
      `invalid runner configuration (${issues}). Set ${ENV_VARS.hubUrl} (and ${ENV_VARS.joinToken} for first contact) or a <ROOT>/config.json.`
    )
  }

  // Fail-fast on an EXPLICITLY-configured pin (env or config.json) against a
  // plaintext ws:// hub: pinning is meaningless without TLS, and silently dropping
  // it would downgrade an operator who asked for pinning to an unpinned connection.
  // A pin that came ONLY from the join token (the auto path) is NOT explicit — it
  // is softly ignored downstream (startRunner) when the resolved url is ws://, so a
  // ws token stays usable for loopback/dev without a hard failure.
  const explicitPin = env[ENV_VARS.pinnedCertSha256] ?? fromShared.pinnedCertSha256
  if (explicitPin !== undefined && urlProtocol(result.data.hubUrl) === 'ws:') {
    throw new Error(
      `${ENV_VARS.pinnedCertSha256} (or config pinnedCertSha256) requires a wss:// hub url; ` +
        `got '${result.data.hubUrl}'. Pinning has no effect without TLS — use a wss:// url or drop the pin.`
    )
  }

  // SLAYZONE_MODE=remote hardening: a remote runner MUST dial the hub over TLS.
  // A plaintext ws:// hub on the open internet is a hard error (credentials +
  // command stream would be unencrypted). Read mode from the passed env so the
  // check stays hermetic under tests. Local mode still allows ws:// for loopback.
  if (env.SLAYZONE_MODE?.trim().toLowerCase() === 'remote' && urlProtocol(result.data.hubUrl) === 'ws:') {
    throw new Error(
      `SLAYZONE_MODE=remote requires a wss:// hub url; got '${result.data.hubUrl}'. ` +
        `A remote runner must use TLS — use a wss:// url (or SLAYZONE_MODE=local for loopback/dev).`
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
