import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import type { AgentEvent } from '@slayzone/terminal/shared'
import { snapshotWorktree, deleteTurnRef, diffIsEmptyCached, diffIsEmpty } from './git-snapshot'
import {
  insertTurn,
  deleteTurn,
  getLatestTurnForWorktree,
  findTurnsToPrune,
} from './db'

/**
 * Check whether a prompt text is "clean" enough to store as a preview.
 * Structured-event sources (chat mode `user-message`) always pass. Raw PTY
 * stdin snapshots don't — they contain edit keystrokes, escape sequences,
 * and bracketed-paste wrappers that can't be reliably reconstructed.
 */
function isCleanPrompt(text: string): boolean {
  // Reject control bytes and ESC, but allow tab (0x09), LF (0x0a), CR (0x0d).
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/.test(text)
}

/** Canonical worktree path: realpath when possible, fall back to raw path. */
function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Lookup task_id + git repo path for a chat tab. Falls back to project.path
 * when task.worktree_path is empty. Returns null if no usable repo path.
 */
function resolveTabContext(
  db: Database,
  tabId: string
): { taskId: string; worktreePath: string } | null {
  const tab = db.prepare(`SELECT task_id FROM terminal_tabs WHERE id = ?`).get(tabId) as
    | { task_id: string }
    | undefined
  if (!tab) return null
  const row = db
    .prepare(
      `SELECT t.worktree_path, p.path AS project_path
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?`
    )
    .get(tab.task_id) as { worktree_path: string | null; project_path: string | null } | undefined
  if (!row) return null
  const repoPath = row.worktree_path || row.project_path
  if (!repoPath) return null
  return { taskId: tab.task_id, worktreePath: canonical(repoPath) }
}

function broadcastChange(worktreePath: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require('electron') as typeof import('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      w.webContents.send('agent-turns:changed', worktreePath)
    }
  } catch {
    // non-electron context (tests) — no-op
  }
}

/**
 * Record a turn boundary. Snapshots the worktree, dedupes against the prev
 * snapshot for the same worktree, prunes oldest beyond cap. Stores task_id
 * for attribution but groups by worktree_path.
 */
export async function recordTurnBoundary(
  db: Database,
  tabId: string,
  promptText: string
): Promise<void> {
  const ctx = resolveTabContext(db, tabId)
  if (!ctx) return
  const id = randomUUID()
  const snap = await snapshotWorktree(ctx.worktreePath, id)
  if (!snap) return
  const { snapshotSha: sha, headSha } = snap

  const prev = getLatestTurnForWorktree(db, ctx.worktreePath)
  // Dedupe semantically — commit SHA always differs (commit message includes
  // turn id). Compare actual diff content.
  if (prev && diffIsEmptyCached(ctx.worktreePath, prev.snapshot_sha, sha)) {
    await deleteTurnRef(ctx.worktreePath, id)
    return
  }
  // Also drop if first turn but identical to HEAD (no actual changes).
  if (!prev) {
    const parentRes = await diffIsEmpty(ctx.worktreePath, `${sha}^`, sha)
    if (parentRes) {
      await deleteTurnRef(ctx.worktreePath, id)
      return
    }
  }

  try {
    insertTurn(db, {
      id,
      worktree_path: ctx.worktreePath,
      task_id: ctx.taskId,
      terminal_tab_id: tabId,
      snapshot_sha: sha,
      head_sha_at_snap: headSha,
      prompt_preview: isCleanPrompt(promptText)
        ? promptText.replace(/\s+/g, ' ').trim().slice(0, 200)
        : '',
      created_at: Date.now(),
    })
  } catch (err) {
    console.error('[turn-tracker] insertTurn failed:', err)
    await deleteTurnRef(ctx.worktreePath, id)
    return
  }

  // Prune oldest beyond cap (per worktree).
  const stale = findTurnsToPrune(db, ctx.worktreePath)
  for (const sid of stale) {
    deleteTurn(db, sid)
    await deleteTurnRef(ctx.worktreePath, sid)
  }

  broadcastChange(ctx.worktreePath)
}

/**
 * Chat-mode entrypoint: pair `user-message` → `result`. Use the captured
 * user prompt as `prompt_preview`.
 */
export function initChatTurnSubscriber(db: Database): (tabId: string, event: AgentEvent) => void {
  const lastUserPromptByTab = new Map<string, string>()
  return (tabId, event) => {
    if (event.kind === 'user-message') {
      lastUserPromptByTab.set(tabId, event.text ?? '')
      return
    }
    if (event.kind === 'result') {
      const prompt = lastUserPromptByTab.get(tabId) ?? ''
      lastUserPromptByTab.delete(tabId)
      void recordTurnBoundary(db, tabId, prompt).catch((err) => {
        console.error('[turn-tracker] recordTurnBoundary (chat) failed:', err)
      })
    }
  }
}

/**
 * xterm-mode entrypoint: each Enter press in an AGENT-mode PTY (claude-code,
 * codex, gemini, etc.) is a turn boundary. Plain shell tabs are skipped.
 *
 * Raw stdin is dropped — it contains edit keystrokes and escape sequences
 * that can't be reliably reconstructed into the user's logical prompt.
 * Turn snapshot still recorded; `prompt_preview` stays empty until a
 * structured-event source exists (see `detectUserPrompt` hook below).
 */
export function initPtyTurnSubscriber(
  db: Database
): (sessionId: string, taskId: string, line: string) => void {
  return (sessionId, taskId, line) => {
    if (!line.trim()) return
    const parts = sessionId.split(':')
    const tabId = parts.length > 1 ? parts.slice(1).join(':') : taskId
    const tabMode = db.prepare(`SELECT mode FROM terminal_tabs WHERE id = ?`).get(tabId) as
      | { mode: string }
      | undefined
    if (!tabMode || tabMode.mode === 'terminal') return
    void recordTurnBoundary(db, tabId, '').catch((err) => {
      console.error('[turn-tracker] recordTurnBoundary (pty) failed:', err)
    })
  }
}
