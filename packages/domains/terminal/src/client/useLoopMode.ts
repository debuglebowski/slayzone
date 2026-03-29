import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalState, LoopConfig, CriteriaType } from '@slayzone/terminal/shared'
import { usePty } from './PtyContext'

export type { LoopConfig, CriteriaType }

export type LoopStatus = 'idle' | 'running' | 'paused' | 'passed' | 'stopped' | 'error' | 'max-reached'

export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f]/g, '')
}

export function checkCriteria(output: string, type: CriteriaType, pattern: string): boolean {
  const stripped = stripAnsi(output)
  switch (type) {
    case 'contains':
      return stripped.includes(pattern)
    case 'not-contains':
      return !stripped.includes(pattern)
    case 'regex':
      try {
        return new RegExp(pattern).test(stripped)
      } catch {
        return false
      }
  }
}

export function isLoopActive(status: LoopStatus): boolean {
  return status === 'running'
}

interface UseLoopModeOptions {
  sessionId: string
  config: LoopConfig | null
  onConfigChange: (config: LoopConfig | null) => void
}

export function useLoopMode({ sessionId, config, onConfigChange }: UseLoopModeOptions) {
  const { subscribeState, subscribeExit, getLastSeq } = usePty()

  const [status, setStatus] = useState<LoopStatus>('idle')
  const [iteration, setIteration] = useState(0)

  // Refs for async callbacks
  const activeRef = useRef(false)
  const configRef = useRef(config)
  configRef.current = config
  const iterationRef = useRef(0)
  const seqRef = useRef(-1)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const onConfigChangeRef = useRef(onConfigChange)
  onConfigChangeRef.current = onConfigChange

  const runIteration = useCallback(() => {
    if (!activeRef.current || !configRef.current) return
    const sid = sessionIdRef.current
    if (!sid) return

    iterationRef.current++
    setIteration(iterationRef.current)
    setStatus('running')

    seqRef.current = getLastSeq(sid)
    window.api.pty.write(sid, configRef.current.prompt + '\r')
  }, [getLastSeq])

  const handleStateChange = useCallback((newState: TerminalState) => {
    if (!activeRef.current || newState !== 'attention') return

    const sid = sessionIdRef.current
    const cfg = configRef.current
    if (!cfg) return

    window.api.pty.getBufferSince(sid, seqRef.current).then((result) => {
      if (!activeRef.current) return
      if (!result) {
        activeRef.current = false
        setStatus('error')
        return
      }

      const output = result.chunks.map(c => c.data).join('')
      if (checkCriteria(output, cfg.criteriaType, cfg.criteriaPattern)) {
        activeRef.current = false
        setStatus('passed')
        return
      }

      if (iterationRef.current >= cfg.maxIterations) {
        activeRef.current = false
        setStatus('max-reached')
        return
      }

      setTimeout(() => runIteration(), 500)
    })
  }, [runIteration])

  useEffect(() => {
    if (!sessionId) return
    const unsubState = subscribeState(sessionId, handleStateChange)
    const unsubExit = subscribeExit(sessionId, () => {
      if (activeRef.current) {
        activeRef.current = false
        setStatus('stopped')
      }
    })
    return () => { unsubState(); unsubExit() }
  }, [sessionId, subscribeState, subscribeExit, handleStateChange])

  const startLoop = useCallback((loopConfig: LoopConfig) => {
    onConfigChangeRef.current(loopConfig)
    configRef.current = loopConfig
    iterationRef.current = 0
    setIteration(0)
    activeRef.current = true
    setStatus('idle')
    runIteration()
  }, [runIteration])

  const pauseLoop = useCallback(() => {
    activeRef.current = false
    setStatus('paused')
  }, [])

  const resumeLoop = useCallback(() => {
    activeRef.current = true
    setStatus('idle')
    runIteration()
  }, [runIteration])

  const stopLoop = useCallback(() => {
    activeRef.current = false
    iterationRef.current = 0
    setIteration(0)
    setStatus('stopped')
  }, [])

  return { status, iteration, startLoop, pauseLoop, resumeLoop, stopLoop }
}
