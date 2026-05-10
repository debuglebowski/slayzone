import { useState, useCallback, useRef } from 'react'
import { useStablePoll } from '@slayzone/ui'
import { isAliveTerminalState } from '@slayzone/terminal/shared'

/**
 * Returns Set of sessionIds with alive PTY sessions
 */
export function usePtyStatus(): Set<string> {
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set())
  const lastHashRef = useRef<string>('')

  const refresh = useCallback(async () => {
    const list = await window.api.pty.list()
    const active = new Set(list.filter((p) => isAliveTerminalState(p.state)).map((p) => p.sessionId))
    const hash = [...active].sort().join('|')
    if (hash !== lastHashRef.current) {
      lastHashRef.current = hash
      setActiveSessionIds(active)
    }
    return hash
  }, [])

  useStablePoll(refresh, { baseDelayMs: 5000 })

  return activeSessionIds
}
