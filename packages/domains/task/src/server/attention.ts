import type { SlayzoneDb } from '@slayzone/platform'
import type { TerminalState } from '@slayzone/terminal/shared'
import { updateTask } from './ops/shared.js'

/**
 * Maintains `needs_attention` on a task in response to PTY state transitions.
 *
 * - `running | background → idle | error` AND session has had user input: set the
 *   flag (agent finished a user-initiated turn).
 * - same transition with NO user input: skip — this is the spawn/banner settle on
 *   auto-respawn (opening a task with no live PTY auto-spawns one), not a real
 *   turn end.
 * - `* → running`: clear the flag (work resumed; transient idle blip should
 *   not leave a stale amber indicator behind).
 * - Renderer also clears it on tab focus.
 *
 * `background` (main agent done, background subagents still working) counts as a
 * WORKING origin but is NOT a clearing destination:
 *   - Setting: a turn that ends while helpers run goes `running → background →
 *     idle`, so the final `→ idle` is the moment it truly settled. Without
 *     `background` in the origin set that turn would earn no amber cue at all.
 *   - Clearing: only the MAIN agent resuming (`→ running`) means "you no longer
 *     need to look at this". Background helper work must never erase the cue.
 *
 * Returns true if the flag value changed, false otherwise.
 */
export async function handleAttentionTransition(
  db: SlayzoneDb,
  sessionId: string,
  newState: TerminalState,
  oldState: TerminalState,
  hasUserInput: boolean
): Promise<boolean> {
  const taskId = sessionId.split(':')[0]
  if (!taskId) return false

  const row = (await db.prepare('SELECT needs_attention FROM tasks WHERE id = ?').get(taskId)) as
    | { needs_attention: number }
    | undefined
  if (!row) return false

  if (newState === 'running') {
    if (!row.needs_attention) return false
    await updateTask(db, { id: taskId, needsAttention: false })
    return true
  }

  if (oldState !== 'running' && oldState !== 'background') return false
  if (newState !== 'idle' && newState !== 'error') return false
  if (!hasUserInput) return false
  if (row.needs_attention) return false

  await updateTask(db, { id: taskId, needsAttention: true })
  return true
}
