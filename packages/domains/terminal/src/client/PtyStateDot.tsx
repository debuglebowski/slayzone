import { TerminalProgressDot, type TerminalProgressDotProps } from '@slayzone/ui'
import type { TerminalState } from '../shared/types'
import {
  useSessionBackgroundJobs,
  useSessionState,
  useSessionStateRaw
} from './useTerminalStateStore'

/** Per-session terminal state. Backed by the reactive store (single source of
 *  truth); name/signature kept so existing callers are unchanged. */
export function useTerminalState(sessionId: string): TerminalState {
  return useSessionState(sessionId)
}

// The dots read the RAW state: a session the store doesn't know is "no session",
// not "starting" — the starting spinner must only mean an agent really is starting.
export function PtyStateDot({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useSessionStateRaw(sessionId)
  const backgroundJobs = useSessionBackgroundJobs(sessionId)
  return <TerminalProgressDot state={state} backgroundJobs={backgroundJobs} alwaysShow />
}

export interface PtyProgressDotProps extends Omit<TerminalProgressDotProps, 'state'> {
  sessionId: string
}

export function PtyProgressDot({
  sessionId,
  ...rest
}: PtyProgressDotProps): React.JSX.Element | null {
  const state = useSessionStateRaw(sessionId)
  const backgroundJobs = useSessionBackgroundJobs(sessionId)
  return <TerminalProgressDot state={state} backgroundJobs={backgroundJobs} {...rest} />
}
