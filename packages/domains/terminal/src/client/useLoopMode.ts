import { useCallback, useEffect, useRef, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { LoopConfig, CriteriaType, LoopStatus } from '@slayzone/terminal/shared'
import { makeLoopController, stripAnsi, checkCriteria, isLoopActive } from '@slayzone/terminal/shared'
import { usePty } from './PtyContext'

// Re-exports preserve existing client-side import paths.
export type { LoopConfig, CriteriaType, LoopStatus }
export { stripAnsi, checkCriteria, isLoopActive }

interface UseLoopModeOptions {
  sessionId: string
  onConfigChange: (config: LoopConfig | null) => void
}

export function useLoopMode({ sessionId, onConfigChange }: UseLoopModeOptions) {
  const trpcClient = useTRPCClient()
  const { subscribeState, subscribeExit, getLastSeq } = usePty()

  const [status, setStatus] = useState<LoopStatus>('idle')
  const [iteration, setIteration] = useState(0)

  const controllerRef = useRef<ReturnType<typeof makeLoopController<number>> | null>(null)
  const onConfigChangeRef = useRef(onConfigChange)
  onConfigChangeRef.current = onConfigChange

  useEffect(() => {
    if (!sessionId) return

    const controller = makeLoopController<number>(
      {
        markBoundary: () => getLastSeq(sessionId),
        send: (prompt) => { trpcClient.pty.submit.mutate({ sessionId, text: prompt }) },
        readOutputSince: async (seq) => {
          const result = await trpcClient.pty.getBufferSince.query({ sessionId, afterSeq: seq })
          if (!result) return null
          return result.chunks.map(c => c.data).join('')
        },
        subscribeIdle: (cb) => subscribeState(sessionId, (newState) => {
          if (newState === 'idle') cb()
        }),
        subscribeExit: (cb) => subscribeExit(sessionId, () => cb()),
      },
      {
        onStatus: setStatus,
        onIteration: setIteration,
      },
    )
    controllerRef.current = controller
    return () => { controller.dispose(); controllerRef.current = null }
  }, [sessionId, subscribeState, subscribeExit, getLastSeq])

  const startLoop = useCallback((loopConfig: LoopConfig) => {
    onConfigChangeRef.current(loopConfig)
    controllerRef.current?.start(loopConfig)
  }, [])

  const pauseLoop = useCallback(() => { controllerRef.current?.pause() }, [])
  const resumeLoop = useCallback(() => { controllerRef.current?.resume() }, [])
  const stopLoop = useCallback(() => { controllerRef.current?.stop() }, [])

  return { status, iteration, startLoop, pauseLoop, resumeLoop, stopLoop }
}
