/**
 * Computer configuration — env-first, layered over the computer's own config file
 * at `<ROOT>/computer.config.json` (see @slayzone/platform/slayzone-config). Precedence:
 *
 *   env var  >  <ROOT>/computer.config.json  >  default
 *
 * (plus the join-token embedded hubUrl/cert as the lowest fallback). Env still
 * wins so operators / the supervised host can override per boot. There is no
 * separate `SLAYZONE_COMPUTER_CONFIG` path-pointing knob — one derived config file.
 *
 * @module computer/config
 */

import { realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  DEFAULT_LOCAL_COMPUTER_NAME,
  loadComputerConfigFile,
  type ComputerConfig as ComputerConfigFile
} from '@slayzone/platform/slayzone-config'
import { hubUrlFromAddr, type SlayzoneMode } from '@slayzone/platform/hub-addr'
import { decodeJoinToken } from '@slayzone/platform/join-token'

export const computerConfigSchema = z.object({
  /** `ws://` or `wss://` hub computer endpoint. */
  hubUrl: z.string().min(1),
  /**
   * Additional hubs this computer serves, beyond `hubUrl`.
   *
   * OPT-IN, and absent by default. The credential store and the project-path
   * store have BOTH been keyed by hub host since they were written, so serving
   * several hubs needs no new persistence — only one dialer each.
   *
   * The cost is stated plainly because it cannot be designed away: every hub's
   * work runs as the SAME OS user, in the same `$HOME`, with the same
   * credentials. `allowedRoots` bounds the RPC surface, not the processes it
   * spawns — one shell command inside a pty leaves it. So this is a convenience,
   * not isolation: for real separation, run one computer per hub under its own
   * OS account, which is the boundary the kernel actually enforces.
   *
   * No env channel: `SLAYZONE_HUB_ADDRESS` carries a single authority
   * (`host[:port]`), and a comma-separated list would collide with that format.
   */
  hubUrls: z.array(z.string().min(1)).optional(),
  /** Required for first contact; later runs reconnect with stored credentials. */
  joinToken: z.string().min(1).optional(),
  /** Human-readable computer name shown on the hub. Defaults to the hostname. */
  name: z.string().min(1),
  /** Filesystem roots this computer may operate under (fs./git. commands). */
  allowedRoots: z.array(z.string().min(1)),
  /** Capability tags advertised at enrollment. */
  capabilities: z.array(z.string().min(1)),
  /** sha256 pin of the hub TLS leaf cert (lowercase hex; colons tolerated). */
  pinnedCertSha256: z.string().min(1).optional()
})
export type ComputerConfig = z.infer<typeof computerConfigSchema>

export const ENV_VARS = {
  // Authority ONLY — `host[:port]`, no scheme, no path. The dial scheme
  // (ws/wss) is derived from SLAYZONE_MODE via hubUrlFromAddr, and `/computers` is
  // appended here, so this env channel can never carry a scheme the CLI would
  // reinterpret (the retired `SLAYZONE_HUB_URL` ws-vs-http collision). computer.config.json
  // `hubUrl` + the join token still carry a FULL url (they're not env-inherited
  // into terminals, so outside the collision).
  hubAddress: 'SLAYZONE_HUB_ADDRESS',
  // HUB_-prefixed because the token is hub-scoped BY VALUE, not by reader: the hub
  // mints it and it embeds the hub's `wss://…/computers` url, the hub's TLS cert
  // fingerprint, and a secret checked against the hub's `join_tokens` row.
  // `mintJoinToken` binds it to NO computer (computer_id is NULL until redemption), so
  // any computer can redeem any unused token — the old `SLAYZONE_RUNNER_JOIN_TOKEN`
  // named its CONSUMER, which is what CLAUDE.md rule 2 forbids. `_TOKEN` suffix +
  // `HUB_` family per rule 3, matching the domain term used everywhere else
  // (`szjt1.`, the `join_tokens` table, mintJoinToken, POST /api/computers/join-token).
  joinToken: 'SLAYZONE_HUB_JOIN_TOKEN'
  // No alias for the pre-rename `SLAYZONE_RUNNER_JOIN_TOKEN`: it never shipped.
  // The published computer betas (0.36.0-beta.2/3) read `SLAYZONE_JOIN_TOKEN`, and
  // the name it was renamed FROM only ever existed on unreleased main, so there is
  // no operator env carrying it. Unmanifested ⇒ sanitizeSpawnEnv strips it, and
  // loadComputerConfig ignores it, so setting it fails loudly with the
  // missing-SLAYZONE_HUB_JOIN_TOKEN error rather than half-working.
  // allowedRoots has NO env channel: a SUPERVISED computer self-derives its FS
  // path-jail to `[homedir()]` (below), a STANDALONE computer gets it from
  // <ROOT>/computer.config.json `allowedRoots` (+ the ROOT default in bin.ts). The
  // computer NAME likewise has no env channel — it derives from SUPERVISED (→
  // DEFAULT_LOCAL_COMPUTER_NAME) or computer.config.json `computerName`, else the hostname.
  // The cert pin has NO env channel either: it arrives via the join token (auto
  // path) or <ROOT>/computer.config.json `pinnedCertSha256` (explicit standalone path).
  // Never a bare env var — a fingerprint is never fished out of ambient env.
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
 * Every fs./git./proc. path argument on the computer MUST pass through this guard
 * before touching the filesystem.
 */
export function assertPathAllowed(candidate: string, allowedRoots: readonly string[]): string {
  if (allowedRoots.length === 0) {
    throw new Error(
      `computer has no allowedRoots configured; refusing filesystem access to '${candidate}'`
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
    `path '${candidate}' is outside the computer's allowedRoots [${allowedRoots.join(', ')}]`
  )
}

type Env = Record<string, string | undefined>

/**
 * Map `<ROOT>/computer.config.json` onto the computer's effective config shape.
 * This is the SINGLE config file for a standalone computer — the former
 * `SLAYZONE_COMPUTER_CONFIG` env var (a second path-pointing knob at an arbitrary
 * file) is gone; there is one derived config at `<ROOT>/computer.config.json`.
 */
function fromSharedConfig(shared: ComputerConfigFile): Partial<ComputerConfig> {
  const out: Partial<ComputerConfig> = {}
  if (shared.hubUrl !== undefined) out.hubUrl = shared.hubUrl
  if (shared.hubUrls !== undefined) out.hubUrls = shared.hubUrls
  if (shared.joinToken !== undefined) out.joinToken = shared.joinToken
  if (shared.computerName !== undefined) out.name = shared.computerName
  // The FS path-jail — locally-declared only, never sourced from hub-pushed data.
  if (shared.allowedRoots !== undefined) out.allowedRoots = shared.allowedRoots
  if (shared.pinnedCertSha256 !== undefined) out.pinnedCertSha256 = shared.pinnedCertSha256
  return out
}

/**
 * Assemble the effective config. Precedence (low→high):
 *   defaults ← <ROOT>/computer.config.json ← environment
 * (with the join-token embedded hubUrl/cert as the lowest fallback). Throws with
 * a readable message when required fields are missing.
 *
 * `shared` defaults to reading `<ROOT>/computer.config.json` ONLY for a STANDALONE
 * computer using the real `process.env`. It is skipped ({}) when:
 *   - a test passes its own `env` object (hermetic — never touch the dev's real
 *     config file), or
 *   - `SLAYZONE_SUPERVISED=1` — the app-spawned local computer
 *     (startLocalComputerWithAutoEnroll passes `{...process.env}`, which carries
 *     SUPERVISED=1). Mirrors the hub's supervised no-op: the Electron host
 *     supplies the computer's env in full (SLAYZONE_HUB_ADDRESS / SLAYZONE_HUB_JOIN_TOKEN),
 *     and the name derives from SUPERVISED (→ DEFAULT_LOCAL_COMPUTER_NAME), so the
 *     shared file must not leak into it. Keeps the supervised computer boot
 *     byte-identical to pre-config behavior.
 * Callers can also pass an explicit shared config to test the layering.
 */
export function loadComputerConfig(
  env: Env = process.env,
  shared: ComputerConfigFile = env === process.env && env.SLAYZONE_SUPERVISED !== '1'
    ? loadComputerConfigFile()
    : {}
): ComputerConfig {
  const fromShared = fromSharedConfig(shared)

  // A join token is self-sufficient: it embeds the hub's `wss://…/computers` URL and
  // the cert fingerprint to pin. Decode it and use those as the LOWEST-precedence
  // fallback for hubUrl + pinnedCertSha256, so `SLAYZONE_HUB_JOIN_TOKEN=… computer` works
  // with no other config. An explicit hubUrl / pin (file or env) still wins, so an
  // operator can point a token at a different endpoint or override the pin. A
  // malformed token decodes to null → no fallback (schema then reports the missing
  // hubUrl, exactly as before).
  //
  // Env precedence: env > computer.config.json. Resolved ONCE here so the token-decode
  // fallback and the `joinToken` field can never disagree about which channel won.
  const envJoinToken = env[ENV_VARS.joinToken]
  const joinToken = envJoinToken ?? fromShared.joinToken
  const fromToken = joinToken ? decodeJoinToken(joinToken) : null

  // The env channel carries only the hub AUTHORITY (host[:port]); compose the
  // full `ws(s)://<addr>/computers` dial url here, scheme from SLAYZONE_MODE (read
  // from the passed `env` so tests stay hermetic). computer.config.json / join-token
  // fallbacks below still supply a full url directly.
  const mode: SlayzoneMode =
    env.SLAYZONE_MODE?.trim().toLowerCase() === 'remote' ? 'remote' : 'local'
  const envAddress = env[ENV_VARS.hubAddress]
  const hubUrlFromEnv =
    envAddress !== undefined ? hubUrlFromAddr(envAddress, 'ws', '/computers', mode) : undefined

  const merged = {
    // Supervised local computer → the shared const so the hub's dedup collapses it
    // to one row; standalone → the hostname (computer.config.json `computerName` overrides
    // via ...fromShared below).
    name: env.SLAYZONE_SUPERVISED === '1' ? DEFAULT_LOCAL_COMPUTER_NAME : hostname(),
    // FS path-jail default. Supervised local computer → `[homedir()]` (it operates
    // on the user's own projects under $HOME); standalone → `[]` here, then
    // computer.config.json `allowedRoots` (...fromShared below) or the SLAYZONE_ROOT
    // fallback in bin.ts. No env channel either way.
    allowedRoots: env.SLAYZONE_SUPERVISED === '1' ? [homedir()] : ([] as string[]),
    capabilities: [...DEFAULT_CAPABILITIES],
    ...(fromToken ? { hubUrl: fromToken.hubUrl, pinnedCertSha256: fromToken.certFingerprint } : {}),
    // <ROOT>/computer.config.json — base under env (spread after). The single config file.
    ...fromShared,
    ...(hubUrlFromEnv !== undefined ? { hubUrl: hubUrlFromEnv } : {}),
    ...(envJoinToken !== undefined ? { joinToken: envJoinToken } : {})
  }

  const result = computerConfigSchema.safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(
      `invalid computer configuration (${issues}). Set ${ENV_VARS.hubAddress} (and ${ENV_VARS.joinToken} for first contact) or a <ROOT>/computer.config.json.`
    )
  }

  // Fail-fast on an EXPLICITLY-configured pin (computer.config.json `pinnedCertSha256`)
  // against a plaintext ws:// hub: pinning is meaningless without TLS, and silently
  // dropping it would downgrade an operator who asked for pinning to an unpinned
  // connection. A pin that came ONLY from the join token (the auto path) is NOT
  // explicit — it is softly ignored downstream (startComputer) when the resolved url
  // is ws://, so a ws token stays usable for loopback/dev without a hard failure.
  const explicitPin = fromShared.pinnedCertSha256
  if (explicitPin !== undefined && urlProtocol(result.data.hubUrl) === 'ws:') {
    throw new Error(
      `config pinnedCertSha256 requires a wss:// hub url; ` +
        `got '${result.data.hubUrl}'. Pinning has no effect without TLS — use a wss:// url or drop the pin.`
    )
  }

  // SLAYZONE_MODE=remote hardening: a remote computer MUST dial the hub over TLS.
  // A plaintext ws:// hub on the open internet is a hard error (credentials +
  // command stream would be unencrypted). This can now only trip on a full ws://
  // url supplied via computer.config.json / join token — an env SLAYZONE_HUB_ADDRESS is
  // authority-only and hubUrlFromAddr forces wss:// in remote mode, so the env
  // path is unrepresentable-as-ws here (the whole point of the ADDRESS redesign).
  // The guard stays to catch the file/token paths. `mode` derived above.
  if (mode === 'remote' && urlProtocol(result.data.hubUrl) === 'ws:') {
    throw new Error(
      `SLAYZONE_MODE=remote requires a wss:// hub url; got '${result.data.hubUrl}'. ` +
        `A remote computer must use TLS — use a wss:// url (or SLAYZONE_MODE=local for loopback/dev).`
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

/** Every hub this computer dials — `hubUrls` when set, else the single `hubUrl`.
 *  De-duplicated, because the same hub twice would mean two dialers racing over
 *  one credential entry. */
export function effectiveHubUrls(config: ComputerConfig): string[] {
  const all = config.hubUrls && config.hubUrls.length > 0 ? config.hubUrls : [config.hubUrl]
  return [...new Set(all)]
}
