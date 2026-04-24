import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { listTurnsForWorktree } from './db'
import { diffIsEmptySync } from './git-snapshot'
import type { AgentTurnRange } from '../shared/types'

function canonical(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * Drop turns whose `prev_sha..snap_sha` produces no diff right now (e.g. legacy
 * rows, same-tree-different-commit-SHA cases that bypassed insert dedupe, or
 * any future scenario where the range collapses). After filtering, the
 * `prev_snapshot_sha` chain stays correct — each surviving row's prev still
 * points at the prior surviving row's snapshot, so consecutive diffs remain
 * meaningful. We re-thread prev_snapshot_sha so dropped turns don't leave
 * dangling SHAs.
 */
function filterAndRethread(repoPath: string, rows: AgentTurnRange[]): AgentTurnRange[] {
  const out: AgentTurnRange[] = []
  let prevSha: string | null = null
  for (const r of rows) {
    const from = prevSha
    if (from !== null && diffIsEmptySync(repoPath, from, r.snapshot_sha)) {
      // Dropped: keep prevSha — next surviving row will diff against the older base.
      continue
    }
    if (from === null && diffIsEmptySync(repoPath, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', r.snapshot_sha)) {
      // First turn but identical to empty tree — nothing in repo. Drop.
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
