import type { Database } from 'better-sqlite3'
import type { TerminalState } from '@slayzone/terminal/shared'
import { updateTask } from './ops/shared.js'

/**
 * Sets `needs_attention = 1` on a task when one of its PTYs transitions
 * `running → idle | error`. The flag signals "agent finished a turn, user has
 * not yet looked." Renderer clears it on tab focus.
 *
 * Returns true if the flag was newly set, false if it was already set or the
 * transition didn't qualify.
 */
export function handleAttentionTransition(
  db: Database,
  sessionId: string,
  newState: TerminalState,
  oldState: TerminalState,
): boolean {
  if (oldState !== 'running') return false
  if (newState !== 'idle' && newState !== 'error') return false

  const taskId = sessionId.split(':')[0]
  if (!taskId) return false

  const row = db.prepare('SELECT needs_attention FROM tasks WHERE id = ?').get(taskId) as
    | { needs_attention: number }
    | undefined
  if (!row || row.needs_attention) return false

  updateTask(db, { id: taskId, needsAttention: true })
  return true
}
