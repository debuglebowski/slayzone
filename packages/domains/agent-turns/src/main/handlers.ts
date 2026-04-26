import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { listTurnsForWorktree } from './db'
import {
  diffIsEmptyCached,
  listTurnFilesCached,
  listWorkingChangedFiles,
  getHeadSha,
  getCommitParentCached,
} from './git-snapshot'
import type { AgentTurnRange } from '../shared/types'

function canonical(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * Filter rules:
 *  1. Drop turns whose snap was taken before a commit landed — i.e. snap's
 *     parent (= HEAD-at-snap-time) is no longer current HEAD. Otherwise
 *     historical turns ghost-resurrect every time their old files get edited
 *     again post-commit (their `prev..snap` diff still references those files).
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
  for (const r of rows) {
    // Rule 1: snap.parent must be current HEAD. Snaps whose parent diverged
    // (commits landed since) are pre-commit history — drop them, even if
    // their files coincidentally re-appear in a fresh edit.
    if (headSha !== null) {
      const parent = getCommitParentCached(repoPath, r.snapshot_sha)
      if (parent !== null && parent !== headSha) continue
    }
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
