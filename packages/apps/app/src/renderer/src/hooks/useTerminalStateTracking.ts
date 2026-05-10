import { useState, useEffect, useRef, useMemo } from 'react'
import type { TerminalState } from '@slayzone/terminal/shared'

type PtyContext = {
  getState: (sessionId: string) => TerminalState
  subscribeState: (sessionId: string, cb: (state: TerminalState) => void) => () => void
}

export function useTerminalStateTracking(
  trackedTaskIds: string[],
  ptyContext: PtyContext
): Map<string, TerminalState> {
  const [terminalStates, setTerminalStates] = useState<Map<string, TerminalState>>(new Map())
  const subsRef = useRef<Map<string, () => void>>(new Map())
  const taskIdsRef = useRef(trackedTaskIds)
  taskIdsRef.current = trackedTaskIds

  // Caller may produce new array refs every render even when contents are
  // stable (e.g. derived from a polled Set). Diffing keys off content avoids
  // tearing down + re-subscribing on every PTY state event.
  const key = useMemo(() => [...trackedTaskIds].sort().join('|'), [trackedTaskIds])

  useEffect(() => {
    const desired = new Set(taskIdsRef.current)
    const subs = subsRef.current
    const removed: string[] = []
    const added: string[] = []

    for (const [taskId, unsub] of subs) {
      if (!desired.has(taskId)) {
        unsub()
        subs.delete(taskId)
        removed.push(taskId)
      }
    }

    for (const taskId of desired) {
      if (subs.has(taskId)) continue
      const sessionId = `${taskId}:${taskId}`
      const unsub = ptyContext.subscribeState(sessionId, (newState) => {
        setTerminalStates((prev) => {
          const next = new Map(prev)
          next.set(taskId, newState)
          return next
        })
      })
      subs.set(taskId, unsub)
      added.push(taskId)
    }

    if (removed.length === 0 && added.length === 0) return

    setTerminalStates((prev) => {
      const next = new Map(prev)
      for (const id of removed) next.delete(id)
      for (const id of added) next.set(id, ptyContext.getState(`${id}:${id}`))
      return next
    })
  }, [key, ptyContext])

  useEffect(() => {
    return () => {
      for (const unsub of subsRef.current.values()) unsub()
      subsRef.current.clear()
    }
  }, [])

  return terminalStates
}
