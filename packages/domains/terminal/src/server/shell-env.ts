// eslint-disable-next-line no-restricted-imports -- KNOWN DEBT: getEnrichedPath runs the login shell once (cached) and can block the hub up to 10s; convert to async.
import { execFileSync } from 'child_process'
import { platform } from 'os'
import {
  resolveUserShell,
  quoteForShell,
  loginShellPathProbes,
  parseLoginShellPathOutput,
  mergePathLists,
  probeLoginShellPath,
  findOnPath,
  LOGIN_SHELL_PATH_PROBE_TIMEOUT_MS
} from '@slayzone/platform'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'

/**
 * Cross-platform shell primitives now live in `@slayzone/platform` so non-terminal
 * packages can share them. Re-exported here unchanged so existing terminal-domain
 * imports (`./shell-env`, the `@slayzone/terminal` barrel) keep resolving.
 */
export {
  setShellOverride,
  getShellOverride,
  shellExists,
  defaultShellForPlatform,
  resolveUserShell,
  getDefaultShell,
  getShellStartupArgs,
  quoteForShell,
  buildExecCommand,
  buildShellInvocation
} from '@slayzone/platform'

/**
 * Cached PATH from a login+interactive shell. Captures nvm/pnpm/asdf/brew
 * additions that Electron's bundled env misses. Lazy — first call spawns the
 * shell (~50-100ms); subsequent calls return cached value. Returns null if
 * shell invocation fails (Windows or broken shell init).
 *
 * Used by both PTY-adjacent spawns (process-manager) and chat SDK spawns
 * (chat-handlers) so subprocess Bash tools find the same binaries the user has.
 */
let cachedEnrichedPath: string | null | undefined
let enrichedPathProbe: Promise<string | null> | undefined
export function getEnrichedPath(): string | null {
  // Probes THIS machine's login shell: refused on a hub with processes switched
  // off (T-06), where nothing should run here to need the PATH anyway.
  assertHubLocalExecEnabled({ op: 'shell.path' })
  if (cachedEnrichedPath !== undefined) return cachedEnrichedPath
  cachedEnrichedPath = resolveEnrichedPath()
  return cachedEnrichedPath
}

/** {@link getEnrichedPath} without blocking: same cache, probed asynchronously. */
export function getEnrichedPathAsync(): Promise<string | null> {
  assertHubLocalExecEnabled({ op: 'shell.path' })
  if (cachedEnrichedPath !== undefined) return Promise.resolve(cachedEnrichedPath)
  enrichedPathProbe ??= probeLoginShellPath().then((path) => {
    cachedEnrichedPath ??= path
    return cachedEnrichedPath
  })
  return enrichedPathProbe
}

function resolveEnrichedPath(): string | null {
  for (const probe of loginShellPathProbes(resolveUserShell())) {
    try {
      const stdout = execFileSync(probe.file, probe.args, {
        timeout: LOGIN_SHELL_PATH_PROBE_TIMEOUT_MS,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const path = parseLoginShellPathOutput(stdout)
      if (path) return path
    } catch {
      /* fall through */
    }
  }
  return null
}

/**
 * Target soft limit for RLIMIT_NOFILE in PTY-spawned shells. macOS default is
 * 256, which is too low for Bun-compiled CLIs (e.g. Factory.ai droid) that
 * open many fds on startup and fail with an opaque "An unknown error occurred
 * (Unexpected)" when they hit EMFILE. 65535 is well within the typical
 * kern.maxfilesperproc (245760 on recent macOS).
 */
const PTY_FD_SOFT_LIMIT = 65535

/**
 * Wrap a shell invocation with a /bin/sh prefix that raises RLIMIT_NOFILE
 * before exec'ing the real shell. The `exec` keyword replaces the sh process
 * so the PID and PTY association are preserved.
 *
 * No-ops on Windows (ulimit unavailable) and when the current soft limit is
 * already at or above the target (never lowers an intentionally-raised limit).
 */
export function wrapShellWithUlimit(
  shell: string,
  args: string[]
): { file: string; args: string[] } {
  if (platform() === 'win32') return { file: shell, args }
  const quoted = [shell, ...args].map(quoteForShell).join(' ')
  // The inner `if` guards against lowering: if `ulimit -n` reports "unlimited"
  // or a value already >= target, leave it alone. Stderr-redirect + `|| true`
  // makes the ulimit call best-effort so a read-only rlimit doesn't abort exec.
  const script = `cur=$(ulimit -n 2>/dev/null); if [ "$cur" != unlimited ] && [ "$cur" -lt ${PTY_FD_SOFT_LIMIT} ] 2>/dev/null; then ulimit -n ${PTY_FD_SOFT_LIMIT} 2>/dev/null || true; fi; exec ${quoted}`
  return { file: '/bin/sh', args: ['-c', script] }
}

/**
 * Find a binary by name on the PATH PTY sessions get (the login shell's).
 * Returns the resolved path or null if not found.
 */
export async function whichBinary(name: string): Promise<string | null> {
  // A login shell on THIS machine: refused on a hub with processes switched off (T-06).
  assertHubLocalExecEnabled({ op: 'shell.which', detail: { binary: name } })
  if (platform() === 'win32') return findOnPath(name, process.env)
  const enrichedPath = await getEnrichedPathAsync()
  return findOnPath(
    name,
    enrichedPath
      ? { ...process.env, PATH: mergePathLists(enrichedPath, process.env.PATH) }
      : process.env
  )
}
