/**
 * Computer configuration — env-first, layered over the computer's own config file
 * at `<ROOT>/computer.config.json` (see @slayzone/platform/slayzone-config). Precedence:
 *
 *   env var  >  <ROOT>/computer.config.json  >  default
 *
 * (plus the join-token embedded hubUrl as the lowest fallback). Env still
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
  ignoredComputerConfigKeys,
  loadComputerConfigFile,
  type ComputerConfig as ComputerConfigFile
} from '@slayzone/platform/slayzone-config'
import { hubUrlFromAddr, isLoopbackComputerUrl } from '@slayzone/platform/hub-addr'
import { decodeJoinToken, joinTokenCarriesCertPin } from '@slayzone/platform/join-token'

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
  /**
   * May a hub change `allowedRoots` (`computer.setAllowedRoots`)? T-27: folder
   * limits are the device user's decision, so NO by default — set them on the
   * device (`slay computer roots`, or `computer.config.json`).
   *
   * Derived only, in {@link loadComputerConfig}: true for the desktop app's own
   * supervised computer when every hub it dials is on loopback — there the hub is
   * the local app (login off, same user, same machine), and it widens the jail for
   * projects the user adds. No file key and no env var sets it, so nothing a hub
   * can write turns it on.
   */
  hubMayEditRoots: z.boolean().optional()
})
export type ComputerConfig = z.infer<typeof computerConfigSchema>

export const ENV_VARS = {
  // Authority ONLY — `host[:port]`, no scheme, no path. The dial scheme
  // (ws/wss) is derived from the host via hubUrlFromAddr (loopback → ws, any other
  // host → wss), and `/computers` is
  // appended here, so this env channel can never carry a scheme the CLI would
  // reinterpret (the retired `SLAYZONE_HUB_URL` ws-vs-http collision). computer.config.json
  // `hubUrl` + the join token still carry a FULL url (they're not env-inherited
  // into terminals, so outside the collision).
  hubAddress: 'SLAYZONE_HUB_ADDRESS',
  // HUB_-prefixed because the token is hub-scoped BY VALUE, not by reader: the hub
  // mints it and it embeds the hub's `wss://…/computers` url and a secret checked
  // against the hub's `join_tokens` row.
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
  // There is no certificate pin on any channel: a wss:// hub's front end is verified
  // the normal way (see ignoredCertPinNotices).
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
 * A path or spawn cwd the computer refuses by its own policy (T-27): outside
 * `allowedRoots`, or one of the computer's own protected state files. The
 * dispatcher maps it to `refusedByComputer` and logs the request as `refused`.
 */
export class JailViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JailViolationError'
  }
}

/**
 * The computer's own state — its config (which holds `allowedRoots`), its
 * credentials, and its local request log — refused to every hub frame even when
 * an allowed root contains it (the supervised default `[homedir()]` does).
 * Without this, `fs.writeFile` on `computer.config.json` would hand a hub the very
 * folder-limit change `computer.setAllowedRoots` refuses, and `fs.delete` would
 * erase the request log. Canonical absolute paths; set once at startup.
 *
 * Frame-level only: a shell the hub starts runs as this user and can still touch
 * these files. See {@link spawnCwd} for what the jail does not bound.
 */
let protectedPaths: readonly string[] = []

export function setProtectedPaths(paths: readonly string[]): void {
  protectedPaths = paths.map((p) => realpathBoundary(p))
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep)
}

/** Is `absolute` (already canonical) one of the protected state paths, or under one? */
export function isProtectedPath(absolute: string): boolean {
  return protectedPaths.some((guarded) => isInside(absolute, guarded))
}

/**
 * Assert that `candidate` is contained within one of `allowedRoots` and return
 * its canonical absolute path. Throws {@link JailViolationError} on traversal
 * outside every configured root (or when no roots are configured at all), or on
 * a protected state path.
 *
 * `subtree`: the caller deletes, moves or overwrites `candidate` with everything
 * under it, so an ANCESTOR of a protected path is refused too — `fs.removeDir`
 * of the computer root would take the request log with it.
 *
 * Every fs./git./proc. path argument on the computer MUST pass through this guard
 * before touching the filesystem.
 */
export function assertPathAllowed(
  candidate: string,
  allowedRoots: readonly string[],
  opts: { subtree?: boolean } = {}
): string {
  if (allowedRoots.length === 0) {
    throw new JailViolationError(
      `computer has no allowedRoots configured; refusing filesystem access to '${candidate}'`
    )
  }
  const resolved = realpathBoundary(candidate)
  for (const guarded of protectedPaths) {
    if (isInside(resolved, guarded) || (opts.subtree && isInside(guarded, resolved))) {
      throw new JailViolationError(
        `path '${candidate}' holds this computer's own state (config, credentials or request log); refused`
      )
    }
  }
  for (const root of allowedRoots) {
    let realRoot: string
    try {
      realRoot = realpathSync.native(resolve(root))
    } catch {
      // A configured root that does not exist cannot contain anything — skip it.
      continue
    }
    if (isInside(resolved, realRoot)) {
      return resolved
    }
  }
  throw new JailViolationError(
    `path '${candidate}' is outside the computer's allowedRoots [${allowedRoots.join(', ')}]`
  )
}

/**
 * The working directory for a process the HUB starts (pty, warm pty, proc / chat
 * agent) — T-27: always inside `allowedRoots`.
 *
 * An explicit `cwd` must pass {@link assertPathAllowed}. None (a global process
 * with no project) runs in the first allowed root that exists, never the
 * computer's own launch directory, which may lie outside every root.
 *
 * WHAT THIS BOUNDS, PLAINLY. It is a cwd/argv-time guard, NOT an OS sandbox. It
 * decides where a process STARTS. It cannot bound what a running process does: a
 * shell or agent runs as this computer's OS user and can `cd /`, read `~/.ssh`,
 * or delete files anywhere that user can. The real boundary is the OS account the
 * computer runs as — run it under a dedicated account for isolation.
 */
export function spawnCwd(cwd: string | undefined, allowedRoots: readonly string[]): string {
  if (cwd !== undefined) return assertPathAllowed(cwd, allowedRoots)
  for (const root of allowedRoots) {
    try {
      return realpathSync.native(resolve(root))
    } catch {
      /* absent root — try the next */
    }
  }
  throw new JailViolationError('computer has no existing allowedRoots; refusing to start a process')
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
  return out
}

/**
 * Assemble the effective config. Precedence (low→high):
 *   defaults ← <ROOT>/computer.config.json ← environment
 * (with the join-token embedded hubUrl as the lowest fallback). Throws with
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

  // A join token is self-sufficient: it embeds the hub's `wss://…/computers` URL.
  // Decode it and use that as the LOWEST-precedence fallback for hubUrl, so
  // `SLAYZONE_HUB_JOIN_TOKEN=… computer` works with no other config. An explicit hubUrl
  // (file or env) still wins, so an operator can point a token at a different
  // endpoint. A malformed token decodes to null → no fallback (schema then reports
  // the missing hubUrl, exactly as before). A pin an older hub put in the token is
  // ignored (decodeJoinToken drops it; ignoredCertPinNotices reports it).
  //
  // Env precedence: env > computer.config.json. Resolved ONCE here so the token-decode
  // fallback and the `joinToken` field can never disagree about which channel won.
  const envJoinToken = env[ENV_VARS.joinToken]
  const joinToken = envJoinToken ?? fromShared.joinToken
  const fromToken = joinToken ? decodeJoinToken(joinToken) : null

  // The env channel carries only the hub AUTHORITY (host[:port]); compose the
  // full `ws(s)://<addr>/computers` dial url here, scheme from the host (rule A1:
  // loopback → ws, any other host → wss). computer.config.json / join-token
  // fallbacks below still supply a full url directly.
  const envAddress = env[ENV_VARS.hubAddress]
  const hubUrlFromEnv =
    envAddress !== undefined ? hubUrlFromAddr(envAddress, 'ws', '/computers') : undefined

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
    ...(fromToken ? { hubUrl: fromToken.hubUrl } : {}),
    // <ROOT>/computer.config.json — base under env (spread after). The single config file.
    ...fromShared,
    ...(hubUrlFromEnv !== undefined ? { hubUrl: hubUrlFromEnv } : {}),
    ...(envJoinToken !== undefined ? { joinToken: envJoinToken } : {})
  }

  const result = computerConfigSchema.safeParse(merged)
  if (result.success) {
    // See `hubMayEditRoots`: the desktop's own computer, talking to the desktop's
    // own loopback hub, and nothing else.
    result.data.hubMayEditRoots =
      env.SLAYZONE_SUPERVISED === '1' &&
      effectiveHubUrls(result.data).every((url) => isLoopbackComputerUrl(url))
  }
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(
      `invalid computer configuration (${issues}). Set ${ENV_VARS.hubAddress} (and ${ENV_VARS.joinToken} for first contact) or a <ROOT>/computer.config.json.`
    )
  }

  // Plaintext `ws://` is for a hub on THIS machine only. Credentials and the
  // command stream would cross the network unencrypted otherwise, and the hub does
  // not terminate TLS itself — a reachable hub sits behind a front end that does,
  // so a non-loopback hub is always a `wss://` url. The env channel can never
  // produce the bad shape (hubUrlFromAddr picks `wss` for a non-loopback host), so
  // this only trips on a full url supplied via computer.config.json / a join token.
  // EVERY hub this computer dials is checked, not only `hubUrl`: `hubUrls` wins over
  // it at dial time (`effectiveHubUrls`), so guarding one field alone leaves the
  // others free to carry the bad shape.
  for (const url of effectiveHubUrls(result.data)) {
    if (urlProtocol(url) === 'ws:' && !isLoopbackComputerUrl(url)) {
      throw new Error(
        `plaintext ws:// is only allowed for a hub on this machine; got '${url}'. ` +
          `A hub other machines reach is served over TLS by its front end — use a wss:// url.`
      )
    }
  }
  return result.data
}

/**
 * Certificate pins an older release enforced and this one IGNORES, one notice each.
 *
 * The hub never terminates TLS, so there is no hub certificate left to pin: a
 * `wss://` hub is reached through a front end whose certificate is verified the
 * normal way (CA chain + hostname, against Node's trust store). A pin still sitting
 * in a join token from an older hub, or in `computer.config.json`, could only ever
 * fail against that certificate. It is ignored rather than refused, so a computer
 * enrolled before the change keeps working against a CA-fronted hub; and it is
 * reported here, so the move from pinning to CA verification is never silent.
 * Verification itself is never relaxed — there is no switch that skips it.
 *
 * Same sources and precedence as {@link loadComputerConfig}: the join token from
 * env, else from the config file, and the file only for a standalone computer.
 */
export function ignoredCertPinNotices(
  env: Env = process.env,
  shared: ComputerConfigFile = env === process.env && env.SLAYZONE_SUPERVISED !== '1'
    ? loadComputerConfigFile()
    : {},
  ignoredFileKeys: readonly string[] = env === process.env && env.SLAYZONE_SUPERVISED !== '1'
    ? ignoredComputerConfigKeys()
    : []
): string[] {
  const notices: string[] = []
  const joinToken = env[ENV_VARS.joinToken] ?? shared.joinToken
  if (joinToken && joinTokenCarriesCertPin(joinToken)) {
    notices.push(
      'ignoring the certificate pin in the join token (minted by an older hub): ' +
        "the hub's certificate is verified against the trusted CAs instead"
    )
  }
  if (ignoredFileKeys.includes('pinnedCertSha256')) {
    notices.push(
      "ignoring 'pinnedCertSha256' in computer.config.json: certificate pinning was removed and " +
        "the hub's certificate is verified against the trusted CAs instead — delete the key"
    )
  }
  return notices
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
