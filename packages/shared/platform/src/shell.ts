/**
 * Cross-platform shell primitives.
 *
 * These resolve and quote the user's shell consistently across macOS, Linux and
 * Windows. They live in `@slayzone/platform` (not the terminal domain) so any
 * package that needs to spawn a command — terminal, process-manager, ai-config —
 * shares one implementation. The terminal domain re-exports them for back-compat.
 *
 * PATH-enrichment and ulimit helpers stay in the terminal domain: they depend on
 * spawning the shell and on terminal-only types.
 */
import fs from 'node:fs'
import { platform, userInfo } from 'os'

/** In-memory shell override — used by E2E tests via IPC, never persisted. */
let shellOverride: string | null = null

export function setShellOverride(value: string | null): void {
  shellOverride = value?.trim() || null
}

/** Current E2E shell override, if any. Lets callers report an invalid override. */
export function getShellOverride(): string | null {
  return shellOverride
}

/**
 * True if `shellPath` exists and is usable as a shell. On POSIX this checks the
 * executable bit; on Windows (no executable bit) it checks existence only.
 */
export function shellExists(shellPath: string): boolean {
  if (platform() === 'win32') return fs.existsSync(shellPath)
  try {
    fs.accessSync(shellPath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Platform fallback shell when nothing else resolves. */
export function defaultShellForPlatform(): string {
  if (platform() === 'win32') return process.env.COMSPEC || 'cmd.exe'
  if (platform() === 'darwin') return '/bin/zsh'
  return '/bin/bash'
}

/**
 * Resolve the shell used to launch terminal sessions.
 * Priority:
 * 1) in-memory override (tests only)
 * 2) SHELL env var
 * 3) os.userInfo().shell
 * 4) platform fallback
 */
export function resolveUserShell(): string {
  if (shellOverride && shellExists(shellOverride)) return shellOverride

  const fromEnv = process.env.SHELL?.trim()
  if (fromEnv && shellExists(fromEnv)) return fromEnv

  try {
    const fromUser = userInfo().shell?.trim()
    if (fromUser && shellExists(fromUser)) return fromUser
  } catch {
    // ignore userInfo lookup failures
  }

  return defaultShellForPlatform()
}

/**
 * Backwards-compatible alias used by existing adapters.
 */
export function getDefaultShell(): string {
  return resolveUserShell()
}

/**
 * Startup args used to emulate typical interactive login terminal behavior.
 */
export function getShellStartupArgs(shellPath: string): string[] {
  if (platform() === 'win32') return []

  const shell = shellPath.toLowerCase()
  const name = shell.split('/').pop() ?? shell
  if (name === 'zsh' || name === 'bash' || name === 'fish') {
    return ['-i', '-l']
  }

  return []
}

/**
 * Quote a single argument for the host platform's shell — single-quote escaping
 * on POSIX, double-quote escaping for cmd.exe on Windows.
 */
export function quoteForShell(arg: string): string {
  if (platform() === 'win32') {
    if (arg.length === 0) return '""'
    if (!/[\s"&|<>^%!]/.test(arg)) return arg
    return `"${arg.replace(/"/g, '""')}"`
  }
  if (arg.length === 0) return "''"
  return `'${arg.replace(/'/g, `'"'"'`)}'`
}

export function buildExecCommand(binary: string, args: string[] = []): string {
  const escaped = [binary, ...args].map(quoteForShell).join(' ')
  if (platform() === 'win32') return escaped
  return `exec ${escaped}`
}

/**
 * Resolve `{ file, args }` to run a command string through the user's login
 * shell, cross-platform:
 * - Windows: `cmd.exe /c <command>`
 * - fish:    `fish -i -l -c <command>`
 * - sh/zsh/bash: `<shell> -l -c <command>`
 *
 * Use this anywhere a command must be run "as if typed in the user's shell" so
 * PATH additions (nvm/pnpm/brew) resolve. The caller still owns cwd/env/detached.
 */
export function buildShellInvocation(command: string): { file: string; args: string[] } {
  const shell = resolveUserShell()
  if (platform() === 'win32') return { file: shell, args: ['/c', command] }
  const isFish = shell.endsWith('/fish')
  return { file: shell, args: [...(isFish ? ['-i', '-l'] : ['-l']), '-c', command] }
}
