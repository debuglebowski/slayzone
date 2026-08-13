/**
 * Keep the co-resident local computer's path-jail wide enough for the projects
 * this hub already has.
 *
 * Before the filesystem ops were routed, the desktop app read and wrote the
 * user's disk directly, with no jail. Routing them through the local computer —
 * whose supervised default is `[homedir()]` — would therefore have silently
 * broken every project living outside the home directory (`/Volumes/...`,
 * `/opt`, an external drive). Widening the jail to match what already worked is
 * not a new permission; it restores the scope the app had before the seam moved.
 *
 * Scope is deliberately the SUPERVISED LOCAL computer only. A remote computer's
 * `allowedRoots` is an operator's deliberate configuration on a machine we do
 * not own, and silently rewriting it on connect would be rude and surprising;
 * that case is served by Settings → Computers instead.
 *
 * The unit seeded is each project's PARENT directory, not the project itself.
 * The default worktree layout is `../{project-folder-name}-workspaces` — a
 * SIBLING of the project — so a jail containing only project paths would admit
 * the checkout and then refuse every worktree created from it. A custom
 * `worktree_base_path` pointing somewhere else entirely still needs a manual
 * entry; nothing here can infer it.
 *
 * @module hub/local-computer-roots
 */

import { dirname, resolve, sep } from 'node:path'

/** True when `candidate` is inside (or equal to) any of `roots`. */
export function isCoveredByRoots(candidate: string, roots: readonly string[]): boolean {
  const target = resolve(candidate)
  return roots.some((root) => {
    const r = resolve(root)
    return target === r || target.startsWith(r + sep)
  })
}

/**
 * Which parent directories are missing from `currentRoots` for these projects.
 *
 * Pure so the policy is testable without a computer: the caller supplies the
 * project paths and the jail, and gets back only the additions.
 */
export function missingRootsForProjects(
  projectPaths: readonly (string | null)[],
  currentRoots: readonly string[]
): string[] {
  const additions: string[] = []
  for (const path of projectPaths) {
    if (!path) continue
    const parent = dirname(resolve(path))
    // `dirname('/')` is `/` — a project at the filesystem root would ask for
    // the whole disk. Refuse to infer that; it can only be a bad path row.
    if (parent === resolve(parent, '..')) continue
    if (isCoveredByRoots(parent, currentRoots)) continue
    if (additions.some((a) => isCoveredByRoots(parent, [a]))) continue
    // A new addition can subsume earlier ones (…/a/b then …/a).
    for (let i = additions.length - 1; i >= 0; i--) {
      if (isCoveredByRoots(additions[i], [parent])) additions.splice(i, 1)
    }
    additions.push(parent)
  }
  return additions
}
