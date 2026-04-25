import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { listTurnsForWorktree } from './db'
import { diffIsEmptyCached, listTurnFilesCached, listWorkingChangedFiles } from './git-snapshot'
import type { AgentTurnRange } from '../shared/types'

function canonical(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * Filter rules:
 *  1. Drop turns whose `prev_sha..snap_sha` is an empty diff (legacy / dedupe
 *     bypass / collapsed range).
 *  2. Drop turns whose changed files have zero overlap with the current
 *     working tree changes — a turn whose files are fully reverted/committed
 *     no longer corresponds to anything in `git status` and shouldn't take a
 *     numbered slot in the UI.
 *
 * Re-thread `prev_snapshot_sha` so dropped turns don't leave dangling SHAs:
 * each surviving row's prev points at the prior surviving row's snapshot, so
 * consecutive diffs remain meaningful.
 */
function filterAndRethread(repoPath: string, rows: AgentTurnRange[]): AgentTurnRange[] {
  const workingSet = listWorkingChangedFiles(repoPath)
  const out: AgentTurnRange[] = []
  let prevSha: string | null = null
  for (const r of rows) {
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
