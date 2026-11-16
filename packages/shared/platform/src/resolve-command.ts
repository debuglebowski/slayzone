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
 * Also `findOnPath`'s answer on POSIX: a filesystem lookup, never a process that
 * may not start in time on a loaded machine.
 *
 * @module platform/resolve-command
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

/** How many PATHs one resolver remembers (the hub's and a computer's are a handful). */
const RESOLVER_CACHE_SIZE = 16

/**
 * A resolver for one command that spawns it by absolute path: a bare name makes the OS
 * try every PATH entry on every spawn (one failed exec per entry before the hit), which
 * is slow on a loaded machine. The path is resolved once per PATH and reused while the
 * file is still there (one stat); a changed PATH or a vanished binary resolves again.
 *
 * Returns the bare name when nothing is found, so the spawn fails with ENOENT exactly
 * as it did, and a later install is picked up on the next call. On Windows only an
 * `.exe`/`.com` is used: a `.cmd`/`.bat` needs a shell, which a plain spawn of the bare
 * name never used either.
 */
export function createCommandResolver(
  command: string,
  platform: NodeJS.Platform = process.platform
): (env?: Record<string, string | undefined>) => string {
  const cache = new Map<string, string>()
  return (env = process.env) => {
    const pathList = env.PATH ?? env.Path ?? ''
    const cached = cache.get(pathList)
    if (cached && isExecutableFile(cached, platform)) return cached
    cache.delete(pathList)
    const found = resolveCommand(command, env as Record<string, string>, undefined, platform)
    if (!found || (platform === 'win32' && !/\.(exe|com)$/i.test(found))) return command
    if (cache.size >= RESOLVER_CACHE_SIZE) cache.delete(cache.keys().next().value as string)
    cache.set(pathList, found)
    return found
  }
}

/**
 * `git` as the hub and the computer spawn it: its absolute path on `env`'s PATH (the
 * env the child gets; default `process.env`), cached — see {@link createCommandResolver}.
 */
export const gitCommand = createCommandResolver('git')
