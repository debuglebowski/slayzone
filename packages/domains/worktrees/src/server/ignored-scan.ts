/**
 * Scan a repo's ignored files into an {@link IgnoredIndex}: one streamed
 * `git ls-files --others --ignored --exclude-standard` (never one giant string),
 * OS/editor artifacts left out, root-level file sizes stat'ed. Runs on the computer
 * (the `git-ops` table) — it spawns git, so hub-bundled code never imports it.
 *
 * @module worktrees/server/ignored-scan
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { streamGitPaths } from './exec-async'
import { IgnoredIndex, isAlwaysExcluded } from './ignored-index'

export async function scanIgnoredIndex(repoPath: string): Promise<IgnoredIndex> {
  const paths: string[] = []
  await streamGitPaths(
    ['ls-files', '--others', '--ignored', '--exclude-standard'],
    { cwd: repoPath },
    (p) => {
      if (!isAlwaysExcluded(p.slice(p.lastIndexOf('/') + 1))) paths.push(p)
    }
  )
  const rootSizes = new Map<string, number>()
  for (const p of paths) {
    if (p.includes('/')) continue
    const size = await stat(path.join(repoPath, p)).then(
      (s) => s.size,
      () => 0
    )
    if (size > 0) rootSizes.set(p, size)
  }
  return IgnoredIndex.build(paths, rootSizes)
}
