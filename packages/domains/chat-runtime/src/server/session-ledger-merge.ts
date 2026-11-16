import type { SessionLedgerBundle } from './session-ledger-bundle'

/**
 * One ledger from the ledgers several computers hold of the same task (its chats may
 * have been spread over them): a row once by its id, a mode's provider config at its
 * highest revision, pre-ledger history as the union of its lists, a resumability proof
 * at its earliest turn. Order follows the first ledger that names a row.
 */
export function mergeSessionLedgers(ledgers: readonly SessionLedgerBundle[]): SessionLedgerBundle {
  const once = <T>(lists: ReadonlyArray<readonly T[]>, key: (row: T) => string): T[] => {
    const seen = new Map<string, T>()
    for (const list of lists)
      for (const row of list) if (!seen.has(key(row))) seen.set(key(row), row)
    return [...seen.values()]
  }
  const turns = new Map<string, SessionLedgerBundle['sessionTurns'][number]>()
  for (const l of ledgers)
    for (const t of l.sessionTurns) {
      const known = turns.get(t.conversationId)
      if (!known || t.firstTurnAt < known.firstTurnAt) turns.set(t.conversationId, t)
    }
  const configs = new Map<string, SessionLedgerBundle['providerConfigs'][number]>()
  for (const l of ledgers)
    for (const c of l.providerConfigs) {
      const known = configs.get(c.mode)
      if (!known || c.revision > known.revision) configs.set(c.mode, c)
    }
  const history = new Map<string, Set<string>>()
  for (const l of ledgers)
    for (const h of l.legacyHistory) {
      const ids = history.get(h.mode) ?? new Set<string>()
      for (const id of h.ids) ids.add(id)
      history.set(h.mode, ids)
    }
  return {
    agentSessions: once(
      ledgers.map((l) => l.agentSessions),
      (r) => r.id
    ),
    taskConversations: once(
      ledgers.map((l) => l.taskConversations),
      (r) => r.id
    ),
    sessionTurns: [...turns.values()],
    sessionResets: once(
      ledgers.map((l) => l.sessionResets),
      (r) => r.id
    ),
    sessionDeletions: once(
      ledgers.map((l) => l.sessionDeletions),
      (r) => r.id
    ),
    legacyHistory: [...history].map(([mode, ids]) => ({ mode, ids: [...ids] })),
    providerConfigs: [...configs.values()]
  }
}
