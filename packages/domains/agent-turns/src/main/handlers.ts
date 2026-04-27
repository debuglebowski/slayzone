import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { listTurnsForWorktree } from './db'
import {
  diffIsEmptyCached,
  listTurnFilesCached,
  listWorkingChangedFiles,
  getHeadSha,
} from './git-snapshot'
import type { AgentTurnRange } from '../shared/types'

function canonical(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * Filter rules:
 *  1. Drop turns whose `head_sha_at_snap` (HEAD-at-snap-time, stored on the
 *     row at insert) doesn't equal current HEAD. Catches the post-commit
 *     ghost-resurrect case: a snap taken before a commit landed must not
 *     reappear when the same files are edited again. NULL = legacy row whose
 *     migration backfill failed (e.g. repo gone) — also drop, can't reason
 *     about it. SQL-driven, no git spawn, no cache to poison.
 *  2. Drop turns whose `prev_sha..snap_sha` is an empty diff (legacy / dedupe
 *     bypass / collapsed range).
 *  3. Drop turns whose changed files have zero overlap with the current
 *     working tree changes — a turn whose files are fully reverted no longer
 *     corresponds to anything in `git status` and shouldn't take a numbered
 *     slot in the UI.
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
  for (const r of rows) {
    // Rule 1: HEAD-at-snap-time must equal current HEAD. Pre-commit snaps
    // (and unrecoverable legacy NULLs) drop. Pure SQL value — no git, no cache.
    if (r.head_sha_at_snap !== headSha) continue
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
