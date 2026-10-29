/**
 * Find a literal (non-shell) command the way the OS will when it is spawned: a
 * path is checked as is, a bare name is looked up on the spawn env's `PATH`.
 *
 * Why the computer checks first: a missing binary otherwise "spawns" — Node
 * answers with a pid-less child and reports ENOENT later, as an exit — so the hub
 * could only say the process ended, never that the agent is not installed. A
 * refusal up front names the binary. A race (removed between this check and the
 * spawn) still surfaces as the ENOENT exit, as before.
 *
 * @module computer/handlers/resolve-command
 */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute path the command resolves to, or null when it is not there. */
export function resolveCommand(
  command: string,
  env: Record<string, string>,
  cwd: string | undefined
): string | null {
  // Windows looks a bare name up with each PATHEXT suffix; POSIX takes it verbatim.
  const suffixes =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : ['']
  const hasDir = command.includes('/') || (process.platform === 'win32' && command.includes('\\'))
  if (hasDir) {
    const base = isAbsolute(command) ? command : join(cwd ?? process.cwd(), command)
    return suffixes.map((s) => base + s).find(isExecutableFile) ?? null
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}
