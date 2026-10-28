import type { TaskPanels } from '@slayzone/task/client/TaskPanels'
import { artifactsTaskPanels } from '@slayzone/task-artifacts/task-panels'
import { worktreesTaskPanels } from '@slayzone/worktrees/task-panels'
import { integrationsTaskPanels } from '@slayzone/integrations/task-panels'

/**
 * The feature panels + hooks TaskDetailPage embeds. The app entry passes this
 * module-level constant to registerTaskPanels once, before its first render.
 */
export const taskPanels: TaskPanels = {
  ...artifactsTaskPanels,
  ...worktreesTaskPanels,
  ...integrationsTaskPanels
}
