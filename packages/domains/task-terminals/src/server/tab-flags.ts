import type { SlayzoneDb } from '@slayzone/platform'

/**
 * Mark a tab's subprocess liveness in DB. Called by pty-manager + chat-transport
 * around spawn/exit so reboots can restore warm agents. Direct DB write — kept
 * lean since hot-path called from spawn/exit handlers.
 *
 * Resolution rules for the tabId arg:
 *   - PTY main session: sessionId is `${taskId}:${taskId}` → main tab row has `id = task_id` (see ensureMainTab insert)
 *   - PTY pane: sessionId is `${taskId}:${tabId}` → tabId is the row id directly
 *   - Chat: tabId is the row id directly
 * Caller resolves the row id and passes it here; we just UPDATE by id.
 */
export async function markTabSpawned(
  db: SlayzoneDb,
  tabId: string,
  wasSpawned: boolean
): Promise<void> {
  await db
    .prepare('UPDATE terminal_tabs SET was_spawned = ? WHERE id = ?')
    .run(wasSpawned ? 1 : 0, tabId)
}

/**
 * Persist a tab's idle-close (hibernation) status so the "sleeping 💤 / Reopen"
 * affordance survives reload + restart. Set true when the idle agent is killed,
 * false on any (re)spawn. Same tabId resolution as `markTabSpawned`.
 */
export async function markTabHibernated(
  db: SlayzoneDb,
  tabId: string,
  hibernated: boolean
): Promise<void> {
  await db
    .prepare('UPDATE terminal_tabs SET hibernated = ? WHERE id = ?')
    .run(hibernated ? 1 : 0, tabId)
}

/** Main-tab session ids (`${taskId}:${taskId}`) for tabs currently flagged
 *  hibernated. Seeds the renderer's PtyContext at boot so the 💤 dot shows for
 *  stale agents before any live session exists. */
export async function listHibernatedSessionIds(db: SlayzoneDb): Promise<string[]> {
  const rows = (await db
    .prepare('SELECT task_id FROM terminal_tabs WHERE hibernated = 1 AND is_main = 1')
    .all()) as Array<{ task_id: string }>
  return rows.map((r) => `${r.task_id}:${r.task_id}`)
}

/**
 * Task ids whose main agent session was alive at last shutdown (`was_spawned`)
 * and isn't explicitly idle-closed (`hibernated`) — the set that should
 * auto-restore on boot. `was_spawned` is tab-bar independent (closing a task's
 * outer UI tab doesn't clear it), so this is used to re-open a background tab
 * for tasks the persisted tab-bar list alone would miss; the existing
 * `wasSpawned` prop on `TerminalStarter` then resumes each one without
 * triggering inference. `mode != 'terminal'` mirrors the `shouldGate`
 * condition in `TerminalSplitGroup` — plain shell tabs always eager-spawn.
 */
export async function listAutoRestoreTaskIds(db: SlayzoneDb): Promise<string[]> {
  const rows = (await db
    .prepare(
      `SELECT tt.task_id FROM terminal_tabs tt
       JOIN tasks t ON t.id = tt.task_id
       WHERE tt.is_main = 1 AND tt.mode != 'terminal'
         AND tt.was_spawned = 1 AND tt.hibernated = 0
         AND t.deleted_at IS NULL`
    )
    .all()) as Array<{ task_id: string }>
  return rows.map((r) => r.task_id)
}
