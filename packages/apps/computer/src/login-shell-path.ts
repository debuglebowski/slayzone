/**
 * Adopt the user's login-shell PATH into this computer's own env, once, at boot.
 *
 * Every process the computer starts inherits `process.env`: git (and the hooks a
 * repo installs — Git LFS), `gh`, worktree setup scripts, background processes,
 * chat agents. Started by the desktop app opened from the Dock/Finder, or by
 * launchd/systemd, that is the OS's bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin` on
 * macOS) — nothing from Homebrew, nvm, pnpm, asdf. Terminals never noticed (their
 * login shell rebuilds PATH); everything else could not find the user's tools.
 *
 * Merged, not replaced: the login shell's entries first (the order the user's
 * terminal resolves in), then whatever the inherited PATH had that it lacks.
 *
 * @module computer/login-shell-path
 */

import { delimiter } from 'node:path'
import { mergePathLists, probeLoginShellPath } from '@slayzone/platform'

/**
 * Merge the login shell's PATH into `env.PATH`. Returns the entries it added, or
 * null when no probe produced a PATH (Windows, a broken shell) — `env` untouched.
 */
export async function adoptLoginShellPath(
  opts: { env?: NodeJS.ProcessEnv; shell?: string } = {}
): Promise<{ added: string[] } | null> {
  const env = opts.env ?? process.env
  const probed = await probeLoginShellPath({ env, ...(opts.shell ? { shell: opts.shell } : {}) })
  if (!probed) return null
  const before = new Set((env.PATH ?? '').split(delimiter))
  env.PATH = mergePathLists(probed, env.PATH)
  return { added: env.PATH.split(delimiter).filter((entry) => !before.has(entry)) }
}
