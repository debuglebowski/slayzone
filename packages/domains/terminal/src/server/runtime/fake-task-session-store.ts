import type { SlayzoneDb } from '@slayzone/platform'
import type { TaskSessionStore } from './task-session-store'

/** One recorded `TaskSessionStore` call: method name, the db it was handed, its args. */
export interface TaskSessionStoreCall {
  method: keyof TaskSessionStore
  db: SlayzoneDb
  args: unknown
}

/**
 * TEST DOUBLE for the task-owned `TaskSessionStore` (terminal tests cannot import
 * the task package). Records every call in `calls` and resolves with the
 * neutral result: `prunePendingSpawns` → 0, `bindSessionToTask` → `bindResult`
 * (default true). The real SQL is covered by task's own op tests.
 */
export function createFakeTaskSessionStore(
  opts: {
    bindResult?: boolean
    /** `isHonoredConversation` answer (default true). */
    honored?: boolean
    /** `getCurrentConversationId` answer per mode (default none). */
    current?: Record<string, string>
  } = {}
): TaskSessionStore & {
  calls: TaskSessionStoreCall[]
} {
  const calls: TaskSessionStoreCall[] = []
  return {
    calls,
    recordConversation: async (db, args) => {
      calls.push({ method: 'recordConversation', db, args })
    },
    recordPendingSpawn: async (db, args) => {
      calls.push({ method: 'recordPendingSpawn', db, args })
    },
    prunePendingSpawns: async (db, args) => {
      calls.push({ method: 'prunePendingSpawns', db, args })
      return 0
    },
    bindSessionToTask: async (db, args) => {
      calls.push({ method: 'bindSessionToTask', db, args })
      return opts.bindResult ?? true
    },
    recordSessionSpawn: async (db, args) => {
      calls.push({ method: 'recordSessionSpawn', db, args })
    },
    markSessionDead: async (db, args) => {
      calls.push({ method: 'markSessionDead', db, args })
    },
    isHonoredConversation: async (db, taskId, mode, conversationId) => {
      calls.push({ method: 'isHonoredConversation', db, args: { taskId, mode, conversationId } })
      return opts.honored ?? true
    },
    getCurrentConversationId: async (db, taskId, mode) => {
      calls.push({ method: 'getCurrentConversationId', db, args: { taskId, mode } })
      return opts.current?.[mode] ?? null
    }
  }
}
