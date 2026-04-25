import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface ExecResult { stdout: string; stderr: string; status: number | null }

function exec(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    })
    const out: string[] = []
    const err: string[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b.toString()))
    child.stderr.on('data', (b: Buffer) => err.push(b.toString()))
    child.on('close', (code) => resolve({ stdout: out.join(''), stderr: err.join(''), status: code }))
    child.on('error', (e) => resolve({ stdout: '', stderr: e.message, status: 1 }))
  })
}

/**
 * Snapshot index+worktree (incl. untracked) as a dangling commit, pin via
 * `refs/slayzone/turns/<turnId>` so `git gc` can't reap it. Non-destructive:
 * uses an isolated GIT_INDEX_FILE so the user's staged state is untouched, and
 * never modifies the worktree.
 *
 * Captures: every file `git add -A` would track (tracked changes + untracked
 * non-ignored). Excludes: gitignored files (intentional — match user
 * expectations from `git status`).
 *
 * Returns SHA on success, null on failure (silent — turn tracking must never
 * break chat).
 */
export async function snapshotWorktree(repoPath: string, turnId: string): Promise<string | null> {
  // Resolve HEAD; bail if no commits yet (e.g. brand-new repo with no commits).
  const head = await exec(['rev-parse', 'HEAD'], repoPath)
  if (head.status !== 0) return null
  const headSha = head.stdout.trim()
  if (!headSha) return null

  let tmpDir: string | null = null
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'slayzone-turn-'))
    const tmpIdx = join(tmpDir, 'index')
    const env = { GIT_INDEX_FILE: tmpIdx }

    // Seed the temp index from HEAD so unchanged files inherit their existing tree entries.
    const read = await exec(['read-tree', headSha], repoPath, env)
    if (read.status !== 0) return null

    // Sync temp index to current worktree (tracked edits + untracked non-ignored).
    const add = await exec(['add', '-A'], repoPath, env)
    if (add.status !== 0) return null

    const tree = await exec(['write-tree'], repoPath, env)
    if (tree.status !== 0) return null
    const treeSha = tree.stdout.trim()
    if (!treeSha) return null

    // ALWAYS create a commit-tree with parent=HEAD. Avoids the previous
    // HEAD-shortcut that produced ambiguous diff bases (HEAD^ != HEAD-at-snap-time).
    // Empty-diff cases are caught downstream (turn-tracker insert dedupe via
    // diffIsEmptyCached, and list-time filter).
    const commit = await exec(
      ['commit-tree', treeSha, '-p', headSha, '-m', `slayzone turn ${turnId}`],
      repoPath
    )
    if (commit.status !== 0) return null
    const sha = commit.stdout.trim()
    if (!sha) return null

    const ref = await exec(['update-ref', `refs/slayzone/turns/${turnId}`, sha], repoPath)
    if (ref.status !== 0) return null
    return sha
  } finally {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

export async function deleteTurnRef(repoPath: string, turnId: string): Promise<void> {
  await exec(['update-ref', '-d', `refs/slayzone/turns/${turnId}`], repoPath)
}

export async function diffIsEmpty(repoPath: string, fromSha: string, toSha: string): Promise<boolean> {
  const res = await exec(['diff', '--quiet', fromSha, toSha], repoPath)
  return res.status === 0
}

/** Synchronous variant for list-time filtering. Returns true if SHAs are
 * identical OR `git diff --quiet` exits 0. */
export function diffIsEmptySync(repoPath: string, fromSha: string, toSha: string): boolean {
  if (fromSha === toSha) return true
  const r = spawnSync('git', ['diff', '--quiet', fromSha, toSha], { cwd: repoPath })
  return r.status === 0
}

/**
 * Memoized version of diffIsEmptySync. Result is a pure function of the
 * `(repoPath, fromSha, toSha)` tuple — both SHAs are content-addressed git
 * objects, so the answer never changes. Bounded LRU cache (FIFO eviction) so
 * a long-running app can't grow it unboundedly. Used by `agent-turns:list` to
 * avoid spawning git for every row on every refetch.
 */
const DIFF_EMPTY_CACHE_MAX = 2000
const diffEmptyCache = new Map<string, boolean>()

export function diffIsEmptyCached(repoPath: string, fromSha: string, toSha: string): boolean {
  if (fromSha === toSha) return true
  const key = `${repoPath}\x00${fromSha}\x00${toSha}`
  const hit = diffEmptyCache.get(key)
  if (hit !== undefined) {
    // Refresh insertion order for LRU-ish behavior.
    diffEmptyCache.delete(key)
    diffEmptyCache.set(key, hit)
    return hit
  }
  const result = diffIsEmptySync(repoPath, fromSha, toSha)
  diffEmptyCache.set(key, result)
  if (diffEmptyCache.size > DIFF_EMPTY_CACHE_MAX) {
    // Evict oldest (Map preserves insertion order).
    const oldestKey = diffEmptyCache.keys().next().value
    if (oldestKey !== undefined) diffEmptyCache.delete(oldestKey)
  }
  return result
}

/** Test-only: clear the cache between scenarios. */
export function _resetDiffEmptyCacheForTests(): void {
  diffEmptyCache.clear()
  turnFilesCache.clear()
}

/**
 * Cached `git diff --name-only fromSha..toSha`. Files in a turn's range are a
 * pure function of the SHA pair (content-addressed), so cache forever within
 * the bounded LRU. Used by list-time intersection filter.
 */
const TURN_FILES_CACHE_MAX = 2000
const turnFilesCache = new Map<string, string[]>()

export function listTurnFilesCached(repoPath: string, fromSha: string, toSha: string): string[] {
  const key = `${repoPath}\x00${fromSha}\x00${toSha}`
  const hit = turnFilesCache.get(key)
  if (hit !== undefined) {
    turnFilesCache.delete(key)
    turnFilesCache.set(key, hit)
    return hit
  }
  const r = spawnSync('git', ['diff', '--name-only', '-z', fromSha, toSha], { cwd: repoPath, encoding: 'utf-8' })
  const files = r.status === 0
    ? r.stdout.split('\0').filter((s) => s.length > 0)
    : []
  turnFilesCache.set(key, files)
  if (turnFilesCache.size > TURN_FILES_CACHE_MAX) {
    const oldestKey = turnFilesCache.keys().next().value
    if (oldestKey !== undefined) turnFilesCache.delete(oldestKey)
  }
  return files
}

/**
 * Set of file paths currently changed in the working tree (tracked edits +
 * untracked non-ignored). NOT cached — working tree state is volatile. Used
 * by list-time filter to drop turns whose files no longer have any current
 * change in the worktree.
 */
export function listWorkingChangedFiles(repoPath: string): Set<string> {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-uall', '-z'], { cwd: repoPath, encoding: 'utf-8' })
  const set = new Set<string>()
  if (r.status !== 0) return set
  // -z output: each entry = `XY <path>\0` (renames add `<orig>\0` after).
  const parts = r.stdout.split('\0')
  let i = 0
  while (i < parts.length) {
    const entry = parts[i]
    if (!entry) { i++; continue }
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    if (path) set.add(path)
    // Renames/copies (R/C in either column) carry an extra origin path entry.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const orig = parts[i + 1]
      if (orig) set.add(orig)
      i += 2
    } else {
      i += 1
    }
  }
  return set
}
