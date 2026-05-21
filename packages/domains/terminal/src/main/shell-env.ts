import { execFile, execFileSync } from 'child_process'
import { platform } from 'os'
import { promisify } from 'util'
import {
  resolveUserShell,
  getShellStartupArgs,
  quoteForShell,
  shellExists,
  getShellOverride
} from '@slayzone/platform'
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
export function getEnrichedPath(): string | null {
  if (cachedEnrichedPath !== undefined) return cachedEnrichedPath
  cachedEnrichedPath = resolveEnrichedPath()
  return cachedEnrichedPath
}

function resolveEnrichedPath(): string | null {
  if (platform() === 'win32') return null
  const shell = resolveUserShell()
  // Fish: $PATH is a list — `echo $PATH` prints space-separated, invalid as OS PATH.
  // `string join ":" $PATH` produces colon-joined.
  const isFish = shell.endsWith('/fish')
  const cmd = isFish ? 'string join ":" $PATH' : 'echo $PATH'

  // Interactive login shell first — sources .zshrc/.bashrc where pnpm/nvm add PATH
  try {
    const args = getShellStartupArgs(shell)
    const result = execFileSync(shell, [...args, '-c', cmd], {
      timeout: 5000,
      encoding: 'utf-8'
    }).trim()
    if (result) return result
  } catch {
    /* fall through */
  }

  // Fallback: login only — sources .zprofile/.bash_profile
  try {
    const result = execFileSync(shell, ['-l', '-c', cmd], {
      timeout: 5000,
      encoding: 'utf-8'
    }).trim()
    if (result) return result
  } catch {
    /* fall through */
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
 * Find a binary by name using the same shell startup context as PTY sessions.
 * Returns the resolved path or null if not found.
 */
export async function whichBinary(name: string): Promise<string | null> {
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
    const shell = resolveUserShell()
    const shellArgs = getShellStartupArgs(shell)
    const checkCmd = `command -v ${quoteForShell(name)}`
    const { stdout } = await execFileAsync(shell, [...shellArgs, '-c', checkCmd], { timeout: 3000 })
    const found = stdout.trim().split('\n')[0]
    return found || null
  } catch {
    return null
  }
}

/**
 * List CCS auth profiles by running `ccs auth list --json`.
 * Returns profile names or empty array if ccs not found / command fails.
 */
export async function listCcsProfiles(): Promise<string[]> {
  const ccsPath = await whichBinary('ccs')
  if (!ccsPath) return []

  try {
    const shell = resolveUserShell()
    const shellArgs = getShellStartupArgs(shell)
    const cmd = `${quoteForShell(ccsPath)} auth list --json`
    const { stdout } = await execFileAsync(shell, [...shellArgs, '-c', cmd], { timeout: 5000 })
    const parsed = JSON.parse(stdout.trim())
    if (Array.isArray(parsed?.profiles)) {
      return parsed.profiles.map((p: { name: string }) => p.name).filter(Boolean)
    }
    return []
  } catch {
    return []
  }
}
