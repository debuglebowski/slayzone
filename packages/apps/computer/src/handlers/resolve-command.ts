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

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Absolute path the command resolves to, or null when it is not there. On Windows
 * the PATHEXT suffixes are tried BEFORE the bare name, as cmd.exe resolves: npm puts
 * an extensionless sh shim (`claude`) next to `claude.cmd`, and only the latter runs.
 */
export function resolveCommand(
  command: string,
  env: Record<string, string>,
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform
): string | null {
  const win = platform === 'win32'
  const suffixes = win
    ? [
        ...(env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean),
        ''
      ]
    : ['']
  const hasDir = command.includes('/') || (win && command.includes('\\'))
  const found = (base: string) =>
    suffixes.map((s) => base + s).find((p) => isExecutableFile(p, platform)) ?? null
  if (hasDir) return found(isAbsolute(command) ? command : join(cwd ?? process.cwd(), command))
  for (const dir of (env.PATH ?? env.Path ?? '').split(win ? ';' : delimiter)) {
    if (!dir) continue
    const hit = found(join(dir, command))
    if (hit) return hit
  }
  return null
}
