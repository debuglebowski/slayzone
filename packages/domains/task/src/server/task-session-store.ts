import type { TaskSessionStore } from '@slayzone/terminal/server'
import {
  bindSessionToTask,
  markSessionDead,
  prunePendingSpawns,
  recordConversation,
  recordPendingSpawn,
  recordSessionSpawn
} from './ops'

/**
 * Task's implementation of the terminal-owned `TaskSessionStore` seam: the
 * `task_conversations` / `agent_sessions` ledger writes the terminal runtime
 * makes. Terminal cannot import task (task → terminal is the only direction), so
 * the composition root hands this object to `createPtyOps`,
 * `createDbChatDataOps` and `createDbWarmPoolDataOps`. Each method IS the task
 * op the runtime used to import directly — same calls, same SQL.
 */
export const taskSessionStore: TaskSessionStore = {
  recordConversation,
  recordPendingSpawn,
  prunePendingSpawns,
  bindSessionToTask,
  recordSessionSpawn,
  markSessionDead
}
