// eslint-disable-next-line no-restricted-imports -- KNOWN DEBT: getEnrichedPath runs the login shell once (cached) and can block the hub up to 10s; convert to async.
import { execFile, execFileSync } from 'child_process'
import { platform } from 'os'
import { promisify } from 'util'
import {
  resolveUserShell,
  quoteForShell,
  shellExists,
  getShellOverride,
  loginShellPathProbes,
  parseLoginShellPathOutput,
  mergePathLists,
  probeLoginShellPath,
  LOGIN_SHELL_PATH_PROBE_TIMEOUT_MS
} from '@slayzone/platform'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'
import type { ValidationResult } from './adapters/types'

const execFileAsync = promisify(execFile)

/**
 * Cross-platform shell primitives now live in `@slayzone/platform` so non-terminal
 * packages can share them. Re-exported here unchanged so existing terminal-domain
 * imports (`./shell-env`, the `@slayzone/terminal` barrel) keep resolving.
 */
export {
  setShellOverride,
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
 * Check if shell environment is available for terminal launching.
 */
export function validateShellEnv(): ValidationResult {
  const override = getShellOverride()
  if (override && !shellExists(override)) {
    return {
      check: 'Shell detected',
      ok: false,
      detail: `Shell override not found: ${override}`,
      fix: 'Clear the shell override or set it to a valid absolute path'
    }
  }

  const shell = resolveUserShell()
  if (!shell) {
    return {
      check: 'Shell detected',
      ok: false,
      detail: 'No usable shell detected',
      fix: 'Set SHELL to a valid shell path (for example /bin/zsh)'
    }
  }

  return { check: 'Shell detected', ok: true, detail: shell }
}

/**
 * Find a binary by name on the PATH PTY sessions get (the login shell's).
 * Returns the resolved path or null if not found.
 */
export async function whichBinary(name: string): Promise<string | null> {
  // A login shell on THIS machine: refused on a hub with processes switched off (T-06).
  assertHubLocalExecEnabled({ op: 'shell.which', detail: { binary: name } })
  if (platform() === 'win32') {
    try {
      const { stdout } = await execFileAsync('where', [name], { timeout: 3000 })
      const found = stdout.trim().split('\n')[0]
      return found || null
    } catch {
      return null
    }
  }

  try {
    // Plain sh over the login-shell PATH, not the interactive shell itself: its
    // startup files print to the same stdout `command -v` answers on, so the first
    // line read back could be a prompt theme instead of a path.
    const enrichedPath = await getEnrichedPathAsync()
    const checkCmd = `command -v ${quoteForShell(name)}`
    const { stdout } = await execFileAsync('/bin/sh', ['-c', checkCmd], {
      timeout: 3000,
      env: enrichedPath
        ? { ...process.env, PATH: mergePathLists(enrichedPath, process.env.PATH) }
        : process.env
    })
    const found = stdout.trim().split('\n')[0]
    return found || null
  } catch {
    return null
  }
}
