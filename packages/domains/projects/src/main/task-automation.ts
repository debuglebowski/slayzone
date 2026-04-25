import type Database from 'better-sqlite3'
import { isTerminalStatus, parseColumnsConfig } from '@slayzone/workflow'

/**
 * Handle terminal state changes by auto-moving tasks to configured statuses.
 * Called from the global PTY state change listener.
 */
export function handleTerminalStateChange(
  db: Database.Database,
  sessionId: string,
  newState: string,
  oldState: string,
  notifyTasksChanged: () => void,
  onReachedTerminal?: (taskId: string) => void
): void {
  let targetField: 'on_terminal_active' | 'on_terminal_idle' | null = null
  if (newState === 'running') targetField = 'on_terminal_active'
  // Both PTY 'attention' (prompt awaiting) and chat 'idle' (turn complete) count as work-done.
  else if (oldState === 'running' && (newState === 'attention' || newState === 'idle')) targetField = 'on_terminal_idle'
  if (!targetField) return

  try {
    const taskId = sessionId.split(':')[0]
    const task = db.prepare('SELECT id, status, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; status: string; project_id: string } | undefined
    if (!task) return

    const project = db.prepare('SELECT task_automation_config, columns_config FROM projects WHERE id = ?').get(task.project_id) as { task_automation_config: string | null; columns_config: string | null } | undefined
    if (!project?.task_automation_config) return

    // Never un-complete or un-cancel a task via terminal activity — explicit terminal status wins.
    const columns = parseColumnsConfig(project.columns_config)
    if (isTerminalStatus(task.status, columns)) return

    const config = JSON.parse(project.task_automation_config) as { on_terminal_active: string | null; on_terminal_idle: string | null }
    const newStatus = config[targetField]
    if (!newStatus || newStatus === task.status) return

    db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, task.id)
    if (isTerminalStatus(newStatus, columns)) onReachedTerminal?.(task.id)
    notifyTasksChanged()
  } catch { /* ignore errors — automation is best-effort */ }
}
