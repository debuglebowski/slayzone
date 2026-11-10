import type { SlayzoneDb } from '@slayzone/platform'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { computerForTurnTask, recordTurnOnComputer } from './turn-git-routing'
import { agentTurnsEvents } from './events'

/**
 * The task of a tab and the computer its checkout is on. Which checkout (its
 * worktree, else its project's folder there) the computer knows itself (§9 Phase
 * 7c: the hub keeps no task path). Null without a computer.
 */
async function resolveTabContext(
  db: SlayzoneDb,
  tabId: string
): Promise<{ taskId: string; projectId: string | null; computerId: string } | null> {
  const row = (await db
    .prepare(
      `SELECT t.id AS task_id, t.project_id FROM terminal_tabs tt JOIN tasks t ON t.id = tt.task_id WHERE tt.id = ?`
    )
    .get(tabId)) as { task_id: string; project_id: string | null } | undefined
  if (!row) return null
  const computerId = await computerForTurnTask(row.task_id)
  // No computer: the snapshot has nowhere to run (the hub runs no git). Skipped
  // quietly — this fires on every agent turn.
  if (computerId == null) return null
  return { taskId: row.task_id, projectId: row.project_id, computerId }
}

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

function broadcastChange(worktreePath: string, taskId: string): void {
  // Pure domain signal — electron-free so this module lives in `server/`. The
  // tRPC `agentTurns.onChanged` subscription wraps this emitter; the Electron-
  // only `initAgentTurnsBroadcast()` subscriber (../electron/agent-turns-broadcast.ts)
  // mirrors each change onto the legacy `agent-turns:changed` + `tasks:changed`
  // webContents.send channels until the renderer drops IPC (slice 5).
  agentTurnsEvents.emit('agent-turns:changed', { worktreePath, taskId })
}

/**
 * Record a turn boundary. The computer holding the checkout snapshots it, drops a
 * turn that changed nothing, keeps the newest per checkout and stores the row: turns
 * live only there (robustness plan §9, P0; hub v207). The hub keeps what it uses
 * itself: the task's "last interaction" (tree-view sort).
 */
export async function recordTurnBoundary(
  db: SlayzoneDb,
  tabId: string,
  promptText: string
): Promise<void> {
  const ctx = await resolveTabContext(db, tabId)
  if (!ctx) return
  const outcome = await recordTurnOnComputer(ctx.computerId, {
    taskId: ctx.taskId,
    tabId,
    projectId: ctx.projectId,
    promptPreview: isCleanPrompt(promptText)
      ? promptText.replace(/\s+/g, ' ').trim().slice(0, 200)
      : ''
  })
  if (!outcome.recorded) return
  await db
    .prepare(
      `UPDATE tasks SET last_interaction_at = ? WHERE id = ? AND (last_interaction_at IS NULL OR last_interaction_at < ?)`
    )
    .run(outcome.createdAt, ctx.taskId, outcome.createdAt)
  broadcastChange(outcome.worktreePath, ctx.taskId)
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
