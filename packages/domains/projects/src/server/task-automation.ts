import type { SlayzoneDb } from '@slayzone/platform'
import { isTerminalStatus, parseColumnsConfig } from '@slayzone/workflow'

/**
 * Handle terminal state changes by auto-moving tasks to configured statuses.
 * Called from the global PTY state change listener.
 */
export async function handleTerminalStateChange(
  db: SlayzoneDb,
  sessionId: string,
  newState: string,
  oldState: string,
  notifyTasksChanged: () => void,
  onReachedTerminal?: (taskId: string) => void
): Promise<void> {
  let targetField: 'on_terminal_active' | 'on_terminal_idle' | null = null
  if (newState === 'running') targetField = 'on_terminal_active'
  else if (oldState === 'running' && newState === 'idle') targetField = 'on_terminal_idle'
  if (!targetField) return

  try {
    const taskId = sessionId.split(':')[0]
    const task = await db.get<{ id: string; status: string; project_id: string }>(
      'SELECT id, status, project_id FROM tasks WHERE id = ?',
      [taskId]
    )
    if (!task) return

    const project = await db.get<{
      task_automation_config: string | null
      columns_config: string | null
    }>('SELECT task_automation_config, columns_config FROM projects WHERE id = ?', [
      task.project_id
    ])
    if (!project?.task_automation_config) return

    // Never un-complete or un-cancel a task via terminal activity — explicit terminal status wins.
    const columns = parseColumnsConfig(project.columns_config)
    if (isTerminalStatus(task.status, columns)) return

    const config = JSON.parse(project.task_automation_config) as {
      on_terminal_active: string | null
      on_terminal_idle: string | null
    }
    const newStatus = config[targetField]
    if (!newStatus || newStatus === task.status) return

    await db.run("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?", [
      newStatus,
      task.id
    ])
    if (isTerminalStatus(newStatus, columns)) onReachedTerminal?.(task.id)
    notifyTasksChanged()
  } catch {
    /* ignore errors — automation is best-effort */
  }
}
