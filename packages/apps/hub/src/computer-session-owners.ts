/**
 * The hub's evidence that a computer session's owner is gone.
 *
 * A computer keeps its terminals and processes running across a hub restart; the
 * hub's routing backends then do not track them. The reconnect sweep never ends a
 * session for being unknown (2026-11-14: that rule killed 31 live agents) — only on
 * positive evidence. This is the hub's: its database PROVES the session's owner
 * gone (a terminal's task deleted / archived / done or its tab closed; a process's
 * row deleted).
 * Anything short of proof — an id it cannot map, a database error — keeps the
 * session (`null`, or a rejection the controller reads as "cannot tell").
 */
import type { SlayzoneDb } from '@slayzone/platform'
import type { OwnerGoneProbe } from '@slayzone/computer-transport/server'
import { whyTaskAgentsEnded } from '@slayzone/task/server'

/** Process ids are `randomUUID()`s (processes domain); anything else is not ours to judge. */
const PROCESS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Terminal sessions are `<taskId>:<tabId>`; the main tab's id IS the task's (its
 * row may be created lazily, so its absence proves nothing).
 */
function parseTerminalSessionId(sessionId: string): { taskId: string; tabId: string } | null {
  const parts = sessionId.split(':')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { taskId: parts[0], tabId: parts[1] }
}

export function createComputerSessionOwners(db: SlayzoneDb): {
  terminal: OwnerGoneProbe
  process: OwnerGoneProbe
} {
  return {
    async terminal(_computerId, sessionId) {
      const id = parseTerminalSessionId(sessionId)
      if (!id) return null
      const ended = await whyTaskAgentsEnded(db, id.taskId)
      if (ended) return ended
      if (id.tabId === id.taskId) return null
      const tab = await db.get<{ id: string }>(
        'SELECT id FROM terminal_tabs WHERE id = ? AND task_id = ?',
        [id.tabId, id.taskId]
      )
      return tab ? null : 'tab-closed'
    },
    async process(_computerId, sessionId) {
      if (!PROCESS_ID.test(sessionId)) return null
      // Only the row's deletion ends a run: Trash, archive and done stop a task's
      // agents, not its processes (nothing ends them there), so they prove nothing.
      // A purged task's rows go with it (ON DELETE CASCADE).
      const row = await db.get<{ id: string }>('SELECT id FROM processes WHERE id = ?', [sessionId])
      return row ? null : 'process-deleted'
    }
  }
}
