import type { TaskSessionStore } from './task-session-store'

/** One recorded `TaskSessionStore` call: method name, the computer it named, its args. */
export interface TaskSessionStoreCall {
  method: keyof TaskSessionStore
  computerId: string | null
  args: unknown
}

/**
 * TEST DOUBLE for the task-owned `TaskSessionStore` (terminal tests cannot import
 * the task package). Records every call in `calls` and resolves with the
 * neutral result: `prunePendingSpawns` → 0, `bindSessionToTask` → `bindResult`
 * (default true). The real SQL is covered by the chat runtime's ledger tests.
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
    recordConversation: async (computerId, args) => {
      calls.push({ method: 'recordConversation', computerId, args })
    },
    recordPendingSpawn: async (computerId, args) => {
      calls.push({ method: 'recordPendingSpawn', computerId, args })
      return `pending-${calls.length}`
    },
    prunePendingSpawns: async (computerId, args) => {
      calls.push({ method: 'prunePendingSpawns', computerId, args })
      return 0
    },
    bindSessionToTask: async (computerId, args) => {
      calls.push({ method: 'bindSessionToTask', computerId, args })
      return opts.bindResult ?? true
    },
    recordSessionSpawn: async (computerId, args) => {
      calls.push({ method: 'recordSessionSpawn', computerId, args })
    },
    markSessionDead: async (computerId, args) => {
      calls.push({ method: 'markSessionDead', computerId, args })
    },
    isHonoredConversation: async (computerId, taskId, mode, conversationId) => {
      calls.push({
        method: 'isHonoredConversation',
        computerId,
        args: { taskId, mode, conversationId }
      })
      return opts.honored ?? true
    },
    getCurrentConversationId: async (computerId, taskId, mode, tabId) => {
      calls.push({ method: 'getCurrentConversationId', computerId, args: { taskId, mode, tabId } })
      return opts.current?.[mode] ?? null
    }
  }
}
