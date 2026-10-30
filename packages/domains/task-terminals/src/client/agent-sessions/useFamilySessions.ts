import { useMemo } from 'react'
import { chatModeForTerminal, terminalModeForChat } from '@slayzone/terminal-contracts'
import { useTaskSessions } from './TaskSessionsSource'
import { mergeFamilySessions, type FamilySessionRow } from './family-sessions'

export type { FamilySessionRow } from './family-sessions'

/** The mode a mode hands conversations to and takes them from (chat ↔ terminal), or null. */
export function handoffPartner(mode: string): string | null {
  return terminalModeForChat(mode) ?? chatModeForTerminal(mode)
}

/** Every session of the task's main agent AND of its hand-off partner (`mergeFamilySessions`). */
export function useFamilySessions(
  taskId: string,
  mode: string,
  enabled: boolean
): FamilySessionRow[] {
  const partner = handoffPartner(mode)
  const own = useTaskSessions(taskId, mode, enabled)
  // Always called (hook order); disabled without a partner.
  const other = useTaskSessions(taskId, partner ?? '', enabled && partner !== null)
  return useMemo(
    () => mergeFamilySessions({ mode, own, partner, other }),
    [own, other, mode, partner]
  )
}
