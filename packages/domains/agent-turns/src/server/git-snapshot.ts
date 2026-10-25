import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeSpawnEnv } from '@slayzone/platform'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'

// Every git here runs against a worktree on the hub's OWN disk, so each spawn is
// refused first on a hub with `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-06): there the
// worktree lives on a computer, and the hub never touches project data.
const refuseOnSwitchedOffHub = (): void => assertHubLocalExecEnabled({ op: 'git.turns' })

const gitSpawn = ((...args: unknown[]): ChildProcess => {
  refuseOnSwitchedOffHub()
  return (spawn as (...a: unknown[]) => ChildProcess)(...args)
}) as typeof spawn

interface ExecResult {
  stdout: string
  stderr: string
  status: number | null
}

function exec(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = gitSpawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Sanitized base (user env survives; SlayZone infra/secret/identity
      // stripped, fail closed) + the caller's overlay (e.g. GIT_INDEX_FILE for
      // the isolated-index snapshot). Keeps the host's hub creds out of any git
      // subprocess env.
      env: { ...sanitizeSpawnEnv(process.env), ...(env ?? {}) }
    })
    const out: string[] = []
    const err: string[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b.toString()))
    child.stderr.on('data', (b: Buffer) => err.push(b.toString()))
    child.on('close', (code) =>
      resolve({ stdout: out.join(''), stderr: err.join(''), status: code })
    )
    child.on('error', (e) => resolve({ stdout: '', stderr: e.message, status: 1 }))
  })
}

export interface SnapshotResult {
  /** SHA of the snap commit (commit-tree output, pinned via refs/slayzone/turns/). */
  snapshotSha: string
  /** HEAD SHA at snap time. Snap is built with `-p HEAD`, so == `snapshotSha^`. */
  headSha: string
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
 * Returns `{snapshotSha, headSha}` on success, null on failure (silent — turn
 * tracking must never break chat). `headSha` is the HEAD-at-snap-time, stored
 * on the row so list-time filtering can drop pre-commit ghosts without re-
 * spawning `git rev-parse <sha>^` (and without risking null cache poisoning).
 */
export async function snapshotWorktree(
  repoPath: string,
  turnId: string
): Promise<SnapshotResult | null> {
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
    return { snapshotSha: sha, headSha }
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

export async function deleteTurnRef(repoPath: string, turnId: string): Promise<void> {
  await exec(['update-ref', '-d', `refs/slayzone/turns/${turnId}`], repoPath)
}

export async function diffIsEmpty(
  repoPath: string,
  fromSha: string,
  toSha: string
): Promise<boolean> {
  const res = await exec(['diff', '--quiet', fromSha, toSha], repoPath)
  return res.status === 0
}

/**
 * Bounded memo for git reads whose answer is a pure function of content-addressed
 * SHAs, so it never changes. Holds the PROMISE, not the value: concurrent callers
 * (two list refetches racing) share one git run instead of spawning twice. FIFO
 * eviction, refreshed on hit, so a long-running hub cannot grow it unboundedly.
 */
function memoAsync<T>(max: number): {
  get(key: string, load: () => Promise<T>): Promise<T>
  clear(): void
} {
  const cache = new Map<string, Promise<T>>()
  return {
    get(key, load) {
      const hit = cache.get(key)
      if (hit !== undefined) {
        cache.delete(key)
        cache.set(key, hit)
        return hit
      }
      const loaded = load()
      cache.set(key, loaded)
      if (cache.size > max) {
        const oldestKey = cache.keys().next().value
        if (oldestKey !== undefined) cache.delete(oldestKey)
      }
      return loaded
    },
    clear: () => cache.clear()
  }
}

// Every read below is ASYNC on purpose. They run on the hub's main thread for
// every agent-turns list refetch, and used to block it: one synchronous git
// spawn per turn. On 2026-10-25 the hub's stall detector caught them freezing it
// for 4.9s during a restart burst (a ~20s freeze two days earlier dropped the
// computer connection). Nothing here may block the event loop.

const diffEmptyCache = memoAsync<boolean>(2000)

/**
 * Memoized `git diff --quiet fromSha toSha`: true if the SHAs are identical or
 * the diff is empty. Used by `agent-turns:list` and turn dedupe to avoid
 * spawning git for every row on every refetch.
 */
export function diffIsEmptyCached(
  repoPath: string,
  fromSha: string,
  toSha: string
): Promise<boolean> {
  if (fromSha === toSha) return Promise.resolve(true)
  return diffEmptyCache.get(`${repoPath}\x00${fromSha}\x00${toSha}`, () =>
    diffIsEmpty(repoPath, fromSha, toSha)
  )
}

const turnFilesCache = memoAsync<string[]>(2000)

/**
 * Cached `git diff --name-only fromSha..toSha`. Files in a turn's range are a
 * pure function of the SHA pair (content-addressed). Used by the list-time
 * intersection filter.
 */
export function listTurnFilesCached(
  repoPath: string,
  fromSha: string,
  toSha: string
): Promise<string[]> {
  return turnFilesCache.get(`${repoPath}\x00${fromSha}\x00${toSha}`, async () => {
    const r = await exec(['diff', '--name-only', '-z', fromSha, toSha], repoPath)
    return r.status === 0 ? r.stdout.split('\0').filter((s) => s.length > 0) : []
  })
}

const treeBlobsCache = memoAsync<Map<string, string> | null>(2000)

/**
 * Per-path blob SHA map for a tree-ish (commit or tree). Pure function of
 * `(repoPath, treeIsh)` once `treeIsh` resolves to a content-addressed object.
 * Resolves null on ls-tree failure (GC'd snap, missing ref, broken repo) —
 * callers fail-closed on null. Caching the null result is intentional so a
 * missing snap doesn't re-spawn ls-tree on every poll.
 */
export function listTreeBlobsCached(
  repoPath: string,
  treeIsh: string
): Promise<Map<string, string> | null> {
  return treeBlobsCache.get(`${repoPath}\x00${treeIsh}`, async () => {
    const r = await exec(['ls-tree', '-r', '-z', treeIsh], repoPath)
    if (r.status !== 0) return null
    const map = new Map<string, string>()
    // ls-tree -r -z: each NUL-terminated record = `<mode> <type> <obj>\t<path>`
    for (const rec of r.stdout.split('\0')) {
      if (!rec) continue
      const tabIdx = rec.indexOf('\t')
      if (tabIdx < 0) continue
      const parts = rec.slice(0, tabIdx).split(' ')
      // Skip non-blobs (submodules show as 'commit', symlinks/dirs handled by -r).
      if (parts.length < 3 || parts[1] !== 'blob') continue
      map.set(rec.slice(tabIdx + 1), parts[2])
    }
    return map
  })
}

/** Test-only: clear the caches between scenarios. */
export function _resetDiffEmptyCacheForTests(): void {
  diffEmptyCache.clear()
  turnFilesCache.clear()
  treeBlobsCache.clear()
}

/**
 * Current HEAD sha for a repo. Working-tree-volatile (commits move it), so
 * not cached. Resolves null on failure.
 */
export async function getHeadSha(repoPath: string): Promise<string | null> {
  const r = await exec(['rev-parse', 'HEAD'], repoPath)
  if (r.status !== 0) return null
  return r.stdout.trim() || null
}

/**
 * Set of file paths currently changed in the working tree (tracked edits +
 * untracked non-ignored). NOT cached — working tree state is volatile. Used
 * by list-time filter to drop turns whose files no longer have any current
 * change in the worktree.
 */
export async function listWorkingChangedFiles(repoPath: string): Promise<Set<string>> {
  const r = await exec(['status', '--porcelain=v1', '-uall', '-z'], repoPath)
  const set = new Set<string>()
  if (r.status !== 0) return set
  // -z output: each entry = `XY <path>\0` (renames add `<orig>\0` after).
  const parts = r.stdout.split('\0')
  let i = 0
  while (i < parts.length) {
    const entry = parts[i]
    if (!entry) {
      i++
      continue
    }
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
