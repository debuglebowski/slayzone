import type { SlayzoneDb } from '@slayzone/platform'
import {
  AGENT_STARTUP_SETTING,
  parseAgentStartupMode,
  restoresRunningAgentsOnBoot,
  type AgentState
} from '@slayzone/terminal-contracts'
import { isTerminalStatus, parseColumnsConfig } from '@slayzone/workflow'

/**
 * Record how a tab's agent last ended (`terminal_tabs.agent_state`). Called by
 * pty-manager + chat-transport around spawn/exit/idle-close (via the injected
 * recorder) so reboots can restore running agents and the Start gate knows what
 * to show. Direct DB write — kept lean since hot-path called from spawn/exit handlers.
 *
 * Resolution rules for the tabId arg:
 *   - PTY main session: sessionId is `${taskId}:${taskId}` → main tab row has `id = task_id` (see ensureMainTab insert)
 *   - PTY pane: sessionId is `${taskId}:${tabId}` → tabId is the row id directly
 *   - Chat: tabId is the row id directly
 * Caller resolves the row id and passes it here; we just UPDATE by id.
 */
export async function setTabAgentState(
  db: SlayzoneDb,
  tabId: string,
  state: AgentState
): Promise<void> {
  await db.prepare('UPDATE terminal_tabs SET agent_state = ? WHERE id = ?').run(state, tabId)
}

/** Main-tab session ids (`${taskId}:${taskId}`) for tabs whose agent the idle
 *  timeout closed (`auto_stopped`). Seeds the renderer's PtyContext at boot so the
 *  💤 dot shows for stale agents before any live session exists. */
export async function listHibernatedSessionIds(db: SlayzoneDb): Promise<string[]> {
  const rows = (await db
    .prepare("SELECT task_id FROM terminal_tabs WHERE agent_state = 'auto_stopped' AND is_main = 1")
    .all()) as Array<{ task_id: string }>
  return rows.map((r) => `${r.task_id}:${r.task_id}`)
}

/**
 * Task ids whose main agent session was alive at last shutdown
 * (`agent_state = 'running'`) — the set that should auto-restore on boot. Empty in
 * the `manual` startup mode: those agents would only show their Start button.
 * `agent_state` is tab-bar independent (closing a task's outer UI tab doesn't
 * clear it), so this is used to re-open a background tab
 * for tasks the persisted tab-bar list alone would miss; the existing
 * `agentState` prop on `TerminalStarter` then resumes each one without
 * triggering inference. `mode != 'terminal'` mirrors the `shouldGate`
 * condition in `TerminalSplitGroup` — plain shell tabs always eager-spawn.
 *
 * Also excludes tasks whose current status is terminal (done/canceled): a
 * task can reach a terminal status while its agent session is still live (or
 * while an exit went undetected, leaving `agent_state` stuck at `running` — see
 * `processes` exit-detection fixes), and reopening a finished task's tab on
 * every boot is never the intent of "auto-restore". Archived tasks likewise:
 * they are out of sight, yet their `agent_state` stays `running` and resumed
 * their agent on every boot.
 */
export async function listAutoRestoreTaskIds(db: SlayzoneDb): Promise<string[]> {
  const setting = (await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(AGENT_STARTUP_SETTING)) as { value: string } | undefined
  if (!restoresRunningAgentsOnBoot(parseAgentStartupMode(setting?.value))) return []
  const rows = (await db
    .prepare(
      `SELECT tt.task_id, t.status, p.columns_config FROM terminal_tabs tt
       JOIN tasks t ON t.id = tt.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE tt.is_main = 1 AND tt.mode != 'terminal'
         AND tt.agent_state = 'running'
         AND t.deleted_at IS NULL
         AND t.archived_at IS NULL`
    )
    .all()) as Array<{ task_id: string; status: string; columns_config: string | null }>
  return rows
    .filter((r) => !isTerminalStatus(r.status, parseColumnsConfig(r.columns_config)))
    .map((r) => r.task_id)
}
