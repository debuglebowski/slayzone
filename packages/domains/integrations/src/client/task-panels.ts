import type { TaskPanels } from '@slayzone/task/client/TaskPanels'
import { ExternalSyncCard } from './ExternalSyncCard'

/**
 * This feature's half of the task page's injected panels (see task's
 * TaskPanels.ts). The app spreads it into what it passes to registerTaskPanels.
 */
export const integrationsTaskPanels = {
  ExternalSyncCard
} satisfies Pick<TaskPanels, 'ExternalSyncCard'>
