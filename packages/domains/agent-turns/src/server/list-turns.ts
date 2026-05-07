import { realpathSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { listTurnsForWorktree } from './db'
import {
  diffIsEmptyCached,
  listTurnFilesCached,
  listTreeBlobsCached,
  listWorkingChangedFiles,
  getHeadSha,
} from './git-snapshot'
import type { AgentTurnRange } from '../shared/types'

function canonical(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * Filter rules:
 *  1. Drop turns whose `head_sha_at_snap` is NULL (legacy row whose migration
 *     backfill failed — can't reason about it).
 *  2. Drop turns whose `prev_sha..snap_sha` is an empty diff (legacy / dedupe
 *     bypass / collapsed range).
 *  3. **Consumed check**: for every file the turn touched, compare the blob at
 *     that path in tree(head_sha_at_snap) vs tree(HEAD). If every touched
 *     file's blob differs (or one side absent), the work landed in HEAD's
 *     history → drop. If any blob is unchanged, the work is still pending →
 *     keep. Survives rebase/merge/squash/amend/external commits.
 *  4. Drop turns with zero overlap with the working tree changes.
 *
 * Re-thread `prev_snapshot_sha` so dropped turns don't leave dangling SHAs.
 */
function filterAndRethread(repoPath: string, rows: AgentTurnRange[]): AgentTurnRange[] {
  const workingSet = listWorkingChangedFiles(repoPath)
  const headSha = getHeadSha(repoPath)
  const out: AgentTurnRange[] = []
  let prevSha: string | null = null
  if (headSha === null) return out
  const headBlobs = listTreeBlobsCached(repoPath, headSha)
  if (headBlobs === null) return out
  for (const r of rows) {
    if (r.head_sha_at_snap === null) continue
    const from = prevSha
    if (from !== null && diffIsEmptyCached(repoPath, from, r.snapshot_sha)) {
      continue
    }
    if (from === null && diffIsEmptyCached(repoPath, `${r.snapshot_sha}^`, r.snapshot_sha)) {
      continue
    }
    const fromForFiles = from ?? `${r.snapshot_sha}^`
    const turnFiles = listTurnFilesCached(repoPath, fromForFiles, r.snapshot_sha)
    const headAtSnapBlobs = listTreeBlobsCached(repoPath, r.head_sha_at_snap)
    if (headAtSnapBlobs === null) continue
    if (turnFiles.length > 0) {
      const consumed = turnFiles.every((f) => {
        const hb = headBlobs.get(f)
        const sb = headAtSnapBlobs.get(f)
        return hb !== sb
      })
      if (consumed) continue
    }
    if (!turnFiles.some((f) => workingSet.has(f))) {
      continue
    }
    out.push({ ...r, prev_snapshot_sha: from })
    prevSha = r.snapshot_sha
  }
  return out
}

export function listAgentTurnsForWorktree(db: Database, worktreePath: string): AgentTurnRange[] {
  if (!worktreePath) return []
  const path = canonical(worktreePath)
  const raw = listTurnsForWorktree(db, path)
  return filterAndRethread(path, raw)
}
