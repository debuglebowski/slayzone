import { useEffect, useState } from 'react'
import { TerminalProgressDot, type TerminalProgressDotProps } from '@slayzone/ui'
import type { TerminalState } from '../shared/types'
import { usePty } from './PtyContext'

export function useTerminalState(sessionId: string): TerminalState {
  const { getState, subscribeState } = usePty()
  const [state, setState] = useState<TerminalState>(() => getState(sessionId))
  useEffect(() => {
    setState(getState(sessionId))
    return subscribeState(sessionId, (next) => setState(next))
  }, [sessionId, getState, subscribeState])
  return state
}

export function PtyStateDot({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useTerminalState(sessionId)
  return <TerminalProgressDot state={state} />
}

export interface PtyProgressDotProps extends Omit<TerminalProgressDotProps, 'state'> {
  sessionId: string
}

export function PtyProgressDot({ sessionId, ...rest }: PtyProgressDotProps): React.JSX.Element | null {
  const state = useTerminalState(sessionId)
  return <TerminalProgressDot state={state} {...rest} />
}
