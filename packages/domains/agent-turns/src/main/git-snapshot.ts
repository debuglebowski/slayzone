import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
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

  let tmpIdx: string | null = null
  try {
    const tmpDir = mkdtempSync(join(tmpdir(), 'slayzone-turn-'))
    tmpIdx = join(tmpDir, 'index')
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

    // If the resulting tree matches HEAD's tree, nothing changed — snapshot HEAD itself
    // so callers still get a comparable ref point.
    const headTree = await exec(['rev-parse', `${headSha}^{tree}`], repoPath)
    let sha: string
    if (headTree.status === 0 && headTree.stdout.trim() === treeSha) {
      sha = headSha
    } else {
      const commit = await exec(
        ['commit-tree', treeSha, '-p', headSha, '-m', `slayzone turn ${turnId}`],
        repoPath
      )
      if (commit.status !== 0) return null
      sha = commit.stdout.trim()
      if (!sha) return null
    }

    const ref = await exec(['update-ref', `refs/slayzone/turns/${turnId}`, sha], repoPath)
    if (ref.status !== 0) return null
    return sha
  } finally {
    if (tmpIdx && existsSync(tmpIdx)) {
      try { rmSync(join(tmpIdx, '..'), { recursive: true, force: true }) } catch { /* ignore */ }
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
