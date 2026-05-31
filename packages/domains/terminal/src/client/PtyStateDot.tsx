import { TerminalProgressDot, type TerminalProgressDotProps } from '@slayzone/ui'
import type { TerminalState } from '../shared/types'
import { useSessionState } from './useTerminalStateStore'

/** Per-session terminal state. Backed by the reactive store (single source of
 *  truth); name/signature kept so existing callers are unchanged. */
export function useTerminalState(sessionId: string): TerminalState {
  return useSessionState(sessionId)
}

export function PtyStateDot({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useTerminalState(sessionId)
  return <TerminalProgressDot state={state} />
}

export interface PtyProgressDotProps extends Omit<TerminalProgressDotProps, 'state'> {
  sessionId: string
}

export function PtyProgressDot({
  sessionId,
  ...rest
}: PtyProgressDotProps): React.JSX.Element | null {
  const state = useTerminalState(sessionId)
  return <TerminalProgressDot state={state} {...rest} />
}
