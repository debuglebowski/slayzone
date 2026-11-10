/**
 * TESTS ONLY: the terminal runtime's session-ledger seam for suites that wire the
 * hub's chat services but run no computer ledger (robustness plan §9: the ledger
 * lives on computers). Reads answer "nothing", writes are dropped — and recorded,
 * so a suite can assert one did (or did not) happen.
 *
 * @module hub/test-session-store
 */
import type { TaskSessionStore } from '@slayzone/terminal/runtime'

export const recordedLedgerCalls: Array<{ method: string; args: unknown[] }> = []

export const taskSessionStore: TaskSessionStore = {
  recordConversation: async (...args) => {
    recordedLedgerCalls.push({ method: 'recordConversation', args })
  },
  recordPendingSpawn: async (...args) => {
    recordedLedgerCalls.push({ method: 'recordPendingSpawn', args })
    return `pending-${recordedLedgerCalls.length}`
  },
  prunePendingSpawns: async () => 0,
  bindSessionToTask: async () => false,
  recordSessionSpawn: async () => undefined,
  markSessionDead: async () => undefined,
  isHonoredConversation: async () => false,
  getCurrentConversationId: async () => null
}
