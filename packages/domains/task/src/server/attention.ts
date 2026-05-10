import type { Database } from 'better-sqlite3'
import type { TerminalState } from '@slayzone/terminal/shared'
import { updateTask } from './ops/shared.js'

/**
 * Maintains `needs_attention` on a task in response to PTY state transitions.
 *
 * - `running → idle | error` AND session has had user input: set the flag
 *   (agent finished a user-initiated turn).
 * - `running → idle | error` with NO user input: skip — this is the
 *   spawn/banner settle on auto-respawn (opening a task with no live PTY
 *   auto-spawns one), not a real turn end.
 * - `* → running`: clear the flag (work resumed; transient idle blip should
 *   not leave a stale amber indicator behind).
 * - Renderer also clears it on tab focus.
 *
 * Returns true if the flag value changed, false otherwise.
 */
export function handleAttentionTransition(
  db: Database,
  sessionId: string,
  newState: TerminalState,
  oldState: TerminalState,
  hasUserInput: boolean,
): boolean {
  const taskId = sessionId.split(':')[0]
  if (!taskId) return false

  const row = db.prepare('SELECT needs_attention FROM tasks WHERE id = ?').get(taskId) as
    | { needs_attention: number }
    | undefined
  if (!row) return false

  if (newState === 'running') {
    if (!row.needs_attention) return false
    updateTask(db, { id: taskId, needsAttention: false })
    return true
  }

  if (oldState !== 'running') return false
  if (newState !== 'idle' && newState !== 'error') return false
  if (!hasUserInput) return false
  if (row.needs_attention) return false

  updateTask(db, { id: taskId, needsAttention: true })
  return true
}
