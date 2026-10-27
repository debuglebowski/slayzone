/**
 * The user's PATH as their own login shell builds it.
 *
 * An app opened from the Dock/Finder, or a service started by launchd/systemd,
 * inherits the OS's bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS) — nothing
 * from Homebrew, nvm, pnpm, asdf. Anything SlayZone spawns outside a terminal (git
 * and the hooks a repo installs, `gh`, setup scripts, chat agents) needs the PATH
 * the user's terminal has, so it is read from the shell itself.
 *
 * Callers run it behind their own exec refusal: the hub's `getEnrichedPath*`, the
 * computer once at boot.
 */
import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import path from 'node:path'
import { getShellStartupArgs, resolveUserShell } from './shell'

export const LOGIN_SHELL_PATH_MARKER = '__SLAYZONE_PATH__'
export const LOGIN_SHELL_PATH_PROBE_TIMEOUT_MS = 5000

export interface LoginShellPathProbe {
  file: string
  args: string[]
}

/**
 * The probes to try in order; the first whose output parses wins. Run each with no
 * stdin (an interactive shell must not wait on one) and stderr discarded.
 */
export function loginShellPathProbes(shell: string): LoginShellPathProbe[] {
  if (platform() === 'win32') return []
  // Fish: $PATH is a list — a bare `$PATH` expands space-separated, invalid as an OS
  // PATH. `string join ":"` produces colon-joined.
  const value = shell.endsWith('/fish') ? '(string join ":" $PATH)' : '"$PATH"'
  // On its own marked line: interactive startup files print to stdout too (prompt
  // themes, gitstatus, terminal-title escapes), and stdout read back whole would
  // carry that noise into PATH.
  const cmd = `printf '\\n${LOGIN_SHELL_PATH_MARKER}%s\\n' ${value}`
  return [
    // Interactive login first — sources .zshrc/.bashrc where pnpm/nvm add PATH
    { file: shell, args: [...getShellStartupArgs(shell), '-c', cmd] },
    // Fallback: login only — sources .zprofile/.bash_profile
    { file: shell, args: ['-l', '-c', cmd] }
  ]
}

/** The PATH a probe printed, or null when its marked line is missing or empty. */
export function parseLoginShellPathOutput(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.startsWith(LOGIN_SHELL_PATH_MARKER)) continue
    return line.slice(LOGIN_SHELL_PATH_MARKER.length).trim() || null
  }
  return null
}

/**
 * `primary`'s entries first (the order the user's terminal resolves in), then any of
 * `secondary`'s it lacks — so whatever the inherited PATH carried survives.
 */
export function mergePathLists(primary: string, secondary: string | undefined): string {
  const entries = new Set<string>()
  for (const entry of [
    ...primary.split(path.delimiter),
    ...(secondary ?? '').split(path.delimiter)
  ]) {
    if (entry) entries.add(entry)
  }
  return [...entries].join(path.delimiter)
}

function runProbe(probe: LoginShellPathProbe, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      probe.file,
      probe.args,
      { encoding: 'utf-8', timeout: LOGIN_SHELL_PATH_PROBE_TIMEOUT_MS, env },
      (err, stdout) => resolve(err ? null : parseLoginShellPathOutput(stdout))
    )
    child.stdin?.end()
  })
}

/**
 * The PATH `shell` (default: the user's) builds when started with `env`, or null
 * (Windows, a broken shell). Async: a heavy zshrc takes over a second.
 */
export async function probeLoginShellPath(
  opts: { shell?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<string | null> {
  for (const probe of loginShellPathProbes(opts.shell ?? resolveUserShell())) {
    const probed = await runProbe(probe, opts.env ?? process.env)
    if (probed) return probed
  }
  return null
}
