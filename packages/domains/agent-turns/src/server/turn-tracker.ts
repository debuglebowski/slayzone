import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { recordedProjectRoot } from '@slayzone/computers/server'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { computerForTurnTask, runTurnGitOp } from './turn-git-routing'
import { insertTurn, deleteTurn, getLatestTurnForWorktree, findTurnsToPrune } from './db'
import { agentTurnsEvents } from './events'

/**
 * Check whether a prompt text is "clean" enough to store as a preview.
 * Structured-event sources (chat mode `user-message`) always pass. Raw PTY
 * stdin snapshots don't — they contain edit keystrokes, escape sequences,
 * and bracketed-paste wrappers that can't be reliably reconstructed.
 */
function isCleanPrompt(text: string): boolean {
  // Reject control bytes and ESC, but allow tab (0x09), LF (0x0a), CR (0x0d).
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/.test(text)
}

/**
 * Lookup task_id, the computer its checkout is on, and the canonical repo path
 * THERE for a chat tab. Falls back to the project's folder on that computer (no
 * computer: the local computer's) when task.worktree_path is empty. Returns null
 * if no usable repo path.
 */
async function resolveTabContext(
  db: SlayzoneDb,
  tabId: string
): Promise<{ taskId: string; worktreePath: string; computerId: string } | null> {
  const tab = (await db.prepare(`SELECT task_id FROM terminal_tabs WHERE id = ?`).get(tabId)) as
    | { task_id: string }
    | undefined
  if (!tab) return null
  const row = (await db
    .prepare(`SELECT worktree_path, project_id FROM tasks WHERE id = ?`)
    .get(tab.task_id)) as { worktree_path: string | null; project_id: string | null } | undefined
  if (!row) return null
  const computerId = await computerForTurnTask(tab.task_id)
  // No computer: the snapshot has nowhere to run (the hub runs no git). Skipped
  // quietly — this fires on every agent turn.
  if (computerId == null) return null
  const projectRoot = row.project_id
    ? await recordedProjectRoot(db, row.project_id, computerId)
    : null
  const repoPath = row.worktree_path || projectRoot
  if (!repoPath) return null
  const worktreePath = await runTurnGitOp(computerId, 'canonical', { repoPath })
  return { taskId: tab.task_id, worktreePath, computerId }
}

/**
 * The task's chat is owned by a computer (any owner past `legacy`): its prompts
 * live on that computer, never on the hub — migration v187's trigger refuses a
 * preview here. The turn itself still records, with no preview, like a terminal's.
 */
async function promptStaysOnComputer(db: SlayzoneDb, taskId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS owned FROM chat_ownership WHERE task_id = ? AND state <> 'legacy' LIMIT 1`
    )
    .get(taskId)
  return Boolean(row)
}

function broadcastChange(worktreePath: string): void {
  // Pure domain signal — electron-free so this module lives in `server/`. The
  // tRPC `agentTurns.onChanged` subscription wraps this emitter; the Electron-
  // only `initAgentTurnsBroadcast()` subscriber (../electron/agent-turns-broadcast.ts)
  // mirrors each change onto the legacy `agent-turns:changed` + `tasks:changed`
  // webContents.send channels until the renderer drops IPC (slice 5).
  agentTurnsEvents.emit('agent-turns:changed', worktreePath)
}

/**
 * Record a turn boundary. Snapshots the worktree, dedupes against the prev
 * snapshot for the same worktree, prunes oldest beyond cap. Stores task_id
 * for attribution but groups by worktree_path.
 */
export async function recordTurnBoundary(
  db: SlayzoneDb,
  tabId: string,
  promptText: string
): Promise<void> {
  const ctx = await resolveTabContext(db, tabId)
  if (!ctx) return
  // The checkout's git runs on its computer (none: this hub's disk).
  const git = <K extends Parameters<typeof runTurnGitOp>[1]>(
    op: K,
    input: Parameters<typeof runTurnGitOp<K>>[2]
  ) => runTurnGitOp(ctx.computerId, op, input)
  const deleteTurnRef = (repoPath: string, turnId: string) =>
    git('deleteTurnRef', { repoPath, turnId })
  const id = randomUUID()
  const snap = await git('snapshot', { repoPath: ctx.worktreePath, turnId: id })
  if (!snap) return
  const { snapshotSha: sha, headSha } = snap

  const prev = await getLatestTurnForWorktree(db, ctx.worktreePath)
  // Dedupe semantically — commit SHA always differs (commit message includes
  // turn id). Compare actual diff content.
  if (
    prev &&
    (await git('diffIsEmpty', {
      repoPath: ctx.worktreePath,
      from: prev.snapshot_sha,
      to: sha,
      cached: true
    }))
  ) {
    await deleteTurnRef(ctx.worktreePath, id)
    return
  }
  // Also drop if first turn but identical to HEAD (no actual changes).
  if (!prev) {
    const parentRes = await git('diffIsEmpty', {
      repoPath: ctx.worktreePath,
      from: `${sha}^`,
      to: sha
    })
    if (parentRes) {
      await deleteTurnRef(ctx.worktreePath, id)
      return
    }
  }

  try {
    await insertTurn(db, {
      id,
      worktree_path: ctx.worktreePath,
      task_id: ctx.taskId,
      terminal_tab_id: tabId,
      snapshot_sha: sha,
      head_sha_at_snap: headSha,
      prompt_preview:
        isCleanPrompt(promptText) && !(await promptStaysOnComputer(db, ctx.taskId))
          ? promptText.replace(/\s+/g, ' ').trim().slice(0, 200)
          : '',
      created_at: Date.now()
    })
  } catch (err) {
    console.error('[turn-tracker] insertTurn failed:', err)
    await deleteTurnRef(ctx.worktreePath, id)
    return
  }

  // Prune oldest beyond cap (per worktree).
  const stale = await findTurnsToPrune(db, ctx.worktreePath)
  for (const sid of stale) {
    await deleteTurn(db, sid)
    await deleteTurnRef(ctx.worktreePath, sid)
  }

  broadcastChange(ctx.worktreePath)
}

/**
 * Chat-mode entrypoint: pair `user-message` → `result`. Use the captured
 * user prompt as `prompt_preview`.
 */
export function initChatTurnSubscriber(db: SlayzoneDb): (tabId: string, event: AgentEvent) => void {
  const lastUserPromptByTab = new Map<string, string>()
  return (tabId, event) => {
    if (event.kind === 'user-message') {
      // A message added to the running turn: the turn's prompt stays the one that opened it.
      if (!event.joinsTurn) lastUserPromptByTab.set(tabId, event.text ?? '')
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
  db: SlayzoneDb
): (sessionId: string, taskId: string, line: string) => Promise<void> {
  return async (sessionId, taskId, line) => {
    if (!line.trim()) return
    const parts = sessionId.split(':')
    const tabId = parts.length > 1 ? parts.slice(1).join(':') : taskId
    const tabMode = (await db.prepare(`SELECT mode FROM terminal_tabs WHERE id = ?`).get(tabId)) as
      | { mode: string }
      | undefined
    if (!tabMode || tabMode.mode === 'terminal') return
    void recordTurnBoundary(db, tabId, '').catch((err) => {
      console.error('[turn-tracker] recordTurnBoundary (pty) failed:', err)
    })
  }
}
