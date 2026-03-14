import { useState, useCallback, useRef, forwardRef, useImperativeHandle } from 'react'
import { Terminal, type TerminalHandle } from '@slayzone/terminal/client/Terminal'
import type { TerminalTab } from '../shared/types'

interface PaneProps {
  tab: TerminalTab
  sessionId: string
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  initialPrompt?: string | null
  providerFlags?: string
  executionContext?: import('@slayzone/terminal/shared').ExecutionContext | null
  onConversationCreated?: (conversationId: string) => void
  onSessionInvalid?: () => void
  onReady?: (api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => void
  onFirstInput?: () => void
  onRetry?: () => void
}

export interface TerminalSplitGroupHandle {
  focus: (sessionId?: string) => void
}

interface TerminalSplitGroupProps {
  panes: PaneProps[]
  isActive?: boolean
  onAttached?: (api: { focus: () => void }) => void
}

export const TerminalSplitGroup = forwardRef<TerminalSplitGroupHandle, TerminalSplitGroupProps>(function TerminalSplitGroup({ panes, isActive, onAttached }, ref) {
  const [sizes, setSizes] = useState<number[]>(() =>
    panes.map(() => 100 / panes.length)
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<{ index: number; startX: number; startSizes: number[] } | null>(null)
  const paneRefs = useRef<Record<string, React.RefObject<TerminalHandle | null>>>({})

  // Ensure a ref exists for each pane
  for (const pane of panes) {
    if (!paneRefs.current[pane.sessionId]) {
      paneRefs.current[pane.sessionId] = { current: null }
    }
  }

  useImperativeHandle(ref, () => ({
    focus: (sessionId?: string) => {
      const id = sessionId ?? panes[0]?.sessionId
      if (id) paneRefs.current[id]?.current?.focus()
    }
  }))

  // Reset sizes when pane count changes
  const prevCountRef = useRef(panes.length)
  if (panes.length !== prevCountRef.current) {
    prevCountRef.current = panes.length
    setSizes(panes.map(() => 100 / panes.length))
  }

  const handleMouseDown = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = {
      index,
      startX: e.clientX,
      startSizes: [...sizes]
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return
      const { index, startX, startSizes } = draggingRef.current
      const containerWidth = containerRef.current.getBoundingClientRect().width
      const deltaPercent = ((e.clientX - startX) / containerWidth) * 100

      const newSizes = [...startSizes]
      const minSize = 10

      let leftSize = startSizes[index] + deltaPercent
      let rightSize = startSizes[index + 1] - deltaPercent

      if (leftSize < minSize) {
        leftSize = minSize
        rightSize = startSizes[index] + startSizes[index + 1] - minSize
      }
      if (rightSize < minSize) {
        rightSize = minSize
        leftSize = startSizes[index] + startSizes[index + 1] - minSize
      }

      newSizes[index] = leftSize
      newSizes[index + 1] = rightSize
      setSizes(newSizes)
    }

    const handleMouseUp = () => {
      draggingRef.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [sizes])

  if (panes.length === 1) {
    const pane = panes[0]
    return (
      <div className="h-full" data-session-id={pane.sessionId}>
        <Terminal
          ref={paneRefs.current[pane.sessionId]}
          key={pane.sessionId}
          sessionId={pane.sessionId}
          cwd={pane.cwd}
          mode={pane.tab.mode}
          conversationId={pane.conversationId}
          existingConversationId={pane.existingConversationId}
          initialPrompt={pane.initialPrompt}
          providerFlags={pane.providerFlags}
          executionContext={pane.executionContext}
          isActive={isActive}
          onAttached={onAttached}
          onConversationCreated={pane.onConversationCreated}
          onSessionInvalid={pane.onSessionInvalid}
          onReady={pane.onReady}
          onFirstInput={pane.onFirstInput}
          onRetry={pane.onRetry}
        />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full flex">
      {panes.map((pane, i) => (
        <div key={pane.sessionId} className="flex" style={{ width: `${sizes[i]}%` }} data-session-id={pane.sessionId}>
          <div className="flex-1 min-w-0">
            <Terminal
              ref={paneRefs.current[pane.sessionId]}
              key={pane.sessionId}
              sessionId={pane.sessionId}
              cwd={pane.cwd}
              mode={pane.tab.mode}
              conversationId={pane.conversationId}
              existingConversationId={pane.existingConversationId}
              initialPrompt={pane.initialPrompt}
                  providerFlags={pane.providerFlags}
              executionContext={pane.executionContext}
              isActive={isActive}
              onAttached={onAttached}
              onConversationCreated={pane.onConversationCreated}
              onSessionInvalid={pane.onSessionInvalid}
              onReady={pane.onReady}
              onFirstInput={pane.onFirstInput}
              onRetry={pane.onRetry}
            />
          </div>
          {i < panes.length - 1 && (
            <div
              className="w-1 cursor-col-resize bg-neutral-200 dark:bg-neutral-700 hover:bg-blue-400 dark:hover:bg-blue-500 transition-colors shrink-0"
              onMouseDown={(e) => handleMouseDown(i, e)}
            />
          )}
        </div>
      ))}
    </div>
  )
})
