import { useMemo } from 'react'
import { chatAgentIdForTerminal, terminalAgentIdForChat } from '@slayzone/terminal-contracts'
import { useTaskSessions } from './TaskSessionsSource'
import { mergeFamilySessions, type FamilySessionRow } from './family-sessions'

export type { FamilySessionRow } from './family-sessions'

/** The mode a mode hands conversations to and takes them from (chat ↔ terminal), or null. */
export function handoffPartner(mode: string): string | null {
  return terminalAgentIdForChat(mode) ?? chatAgentIdForTerminal(mode)
}

/** Every session of a tab's agent AND of its hand-off partner (`mergeFamilySessions`).
 *  `tabId`: the terminal tab asking (default: the main tab). */
export function useFamilySessions(
  taskId: string,
  mode: string,
  enabled: boolean,
  tabId?: string
): FamilySessionRow[] {
  const partner = handoffPartner(mode)
  const own = useTaskSessions(taskId, mode, enabled, tabId)
  // Always called (hook order); disabled without a partner.
  const other = useTaskSessions(taskId, partner ?? '', enabled && partner !== null, tabId)
  return useMemo(
    () => mergeFamilySessions({ mode, own, partner, other }),
    [own, other, mode, partner]
  )
}
