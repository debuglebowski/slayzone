/**
 * Building a HISTORICAL release from git (the upgrade/maintenance-bridge tests): file
 * contents come from `git show <ref>:<path>`, but esbuild resolves imports against
 * the CURRENT disk. A module the old release imported that has since been moved or
 * deleted therefore fails to resolve. This resolves such a relative import from the
 * ref itself, so a historical build depends only on that ref.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx']

function existsAtRef(root: string, ref: string, absPath: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${relative(root, absPath)}`], {
      cwd: root,
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

/**
 * esbuild `onResolve` for relative specifiers: undefined when the import resolves on
 * disk (esbuild's own resolution applies), else the path it had at `ref`.
 */
export function resolveMissingFromRef(
  root: string,
  ref: string,
  args: { path: string; resolveDir: string }
): { path: string } | undefined {
  const base = resolve(args.resolveDir, args.path)
  if (CANDIDATE_SUFFIXES.some((s) => existsSync(base + s))) return undefined
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix
    if (existsAtRef(root, ref, candidate)) return { path: candidate }
  }
  return undefined
}

/** The on-disk real path when the file still exists, else the ref-only path as given. */
export function snapshotPath(path: string, realpath: (p: string) => string): string {
  return existsSync(path) ? realpath(path) : path
}
