import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { listTurnsForWorktree } from '../server/db'
import {
  diffIsEmptyCached,
  listTurnFilesCached,
  listTreeBlobsCached,
  listWorkingChangedFiles,
  getHeadSha,
} from '../server/git-snapshot'
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
 *  3. **Consumed check** (replaces the old strict `head_sha_at_snap == HEAD`
 *     equality). For every file the turn touched, compare the blob at that
 *     path in `tree(head_sha_at_snap)` vs `tree(HEAD)`. If *every* touched
 *     file's blob differs (or one side absent and the other defined), the
 *     work landed in HEAD's history → drop. If *any* file's blob is
 *     unchanged between snap-time HEAD and current HEAD, the file was never
 *     touched by intervening commits → that part of the turn's work is
 *     still pending → keep. Survives rebase / merge / squash / amend /
 *     external commits, where strict HEAD equality over-fires and orphans
 *     turns whose work is uncommitted.
 *  4. Drop turns whose changed files have zero overlap with the current
 *     working tree changes — a turn whose files are fully reverted (without
 *     a commit) no longer corresponds to anything in `git status`.
 *
 * Re-thread `prev_snapshot_sha` so dropped turns don't leave dangling SHAs:
 * each surviving row's prev points at the prior surviving row's snapshot, so
 * consecutive diffs remain meaningful.
 */
function filterAndRethread(repoPath: string, rows: AgentTurnRange[]): AgentTurnRange[] {
  const workingSet = listWorkingChangedFiles(repoPath)
  const headSha = getHeadSha(repoPath)
  const out: AgentTurnRange[] = []
  let prevSha: string | null = null
  // Fail-closed: if `git rev-parse HEAD` failed (broken repo, perms, etc.) we
  // can't safely classify any row as fresh, so drop everything. Better an empty
  // turn list than ghost turns from random history.
  if (headSha === null) return out
  const headBlobs = listTreeBlobsCached(repoPath, headSha)
  // Same fail-closed posture for HEAD's tree: if ls-tree fails we can't
  // distinguish landed vs pending.
  if (headBlobs === null) return out
  for (const r of rows) {
    // Rule 1: legacy NULL drop (head_sha_at_snap backfill failed).
    if (r.head_sha_at_snap === null) continue
    const from = prevSha
    if (from !== null && diffIsEmptyCached(repoPath, from, r.snapshot_sha)) {
      // Dropped: keep prevSha — next surviving row will diff against the older base.
      continue
    }
    if (from === null && diffIsEmptyCached(repoPath, `${r.snapshot_sha}^`, r.snapshot_sha)) {
      // First turn but identical to its parent (HEAD-at-snap-time) — no real changes. Drop.
      continue
    }
    const fromForFiles = from ?? `${r.snapshot_sha}^`
    const turnFiles = listTurnFilesCached(repoPath, fromForFiles, r.snapshot_sha)
    // Rule 3: consumed check. Fail-closed when head-at-snap tree is unreadable
    // (commit GC'd, repo corruption): drop, matching the getHeadSha-null
    // posture above.
    const headAtSnapBlobs = listTreeBlobsCached(repoPath, r.head_sha_at_snap)
    if (headAtSnapBlobs === null) continue
    if (turnFiles.length > 0) {
      const consumed = turnFiles.every((f) => {
        const hb = headBlobs.get(f)
        const sb = headAtSnapBlobs.get(f)
        // Both undefined (file absent at both points) → unchanged → pending.
        // Both defined and equal → unchanged → pending. Otherwise → changed
        // (incl. created or deleted between then and now) → that file's work
        // is reflected in HEAD's history.
        return hb !== sb
      })
      if (consumed) continue
    }
    // Rule 4: file-overlap with working tree.
    if (!turnFiles.some((f) => workingSet.has(f))) {
      // Turn's files no longer present in working tree changes — drop, keep prevSha.
      continue
    }
    out.push({ ...r, prev_snapshot_sha: from })
    prevSha = r.snapshot_sha
  }
  return out
}

export function registerAgentTurnsHandlers(ipcMain: IpcMain, db: Database): void {
  ipcMain.handle('agent-turns:list', (_, worktreePath: string) => {
    if (!worktreePath) return []
    const path = canonical(worktreePath)
    const raw = listTurnsForWorktree(db, path)
    return filterAndRethread(path, raw)
  })
}
