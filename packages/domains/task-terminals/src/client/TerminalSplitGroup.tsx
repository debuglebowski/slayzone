import { useState, useCallback, useRef, forwardRef, useImperativeHandle, lazy, Suspense } from 'react'
import { Terminal, type TerminalHandle } from '@slayzone/terminal/client/LazyTerminal'
import type { TerminalTab } from '../shared/types'
import { isChatSupported } from '../shared/chat-modes'
import { TerminalContextMenu } from './TerminalContextMenu'
import type { ChatPanelHandle } from './chat/ChatPanel'
import { Skeleton } from '@slayzone/ui'

const ChatPanel = lazy(() => import('./chat/ChatPanel').then((m) => ({ default: m.ChatPanel })))

function ChatPanelSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1" />
      <div className="border-t border-border p-2">
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
    </div>
  )
}
import { TerminalStarter } from './TerminalStarter'

interface PaneProps {
  tab: TerminalTab
  taskId: string
  sessionId: string
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  supportsSessionId?: boolean
  initialPrompt?: string | null
  providerFlags?: string
  executionContext?: import('@slayzone/terminal/shared').ExecutionContext | null
  permissionNotice?: string | null
  /** Owning task is temporary — gates auto-start off (regular-task-only). */
  isTemporary?: boolean
  onStartFresh?: () => void
  onReady?: (api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => void
  onFirstInput?: () => void
  onRetry?: () => void
  // Context menu callbacks
  onSplit?: () => void
  onNewGroup?: () => void
  onClose?: (() => void) | null
  onRename?: (() => void) | null
  onResetSession?: (() => void) | null
}

export interface TerminalSplitGroupHandle {
  focus: (sessionId?: string) => void
}

interface TerminalSplitGroupProps {
  panes: PaneProps[]
  isActive?: boolean
  /** Panel is mid-resize — pause xterm re-fit in each pane (no remount). */
  paused?: boolean
  onAttached?: (api: { sessionId: string; focus: () => void }) => void
  onOpenUrl?: (url: string) => void
  onOpenFile?: (filePath: string, options?: { position?: { line: number; col?: number } }) => void
}

export const TerminalSplitGroup = forwardRef<TerminalSplitGroupHandle, TerminalSplitGroupProps>(
  function TerminalSplitGroup({ panes, isActive, paused, onAttached, onOpenUrl, onOpenFile }, ref) {
    const [sizes, setSizes] = useState<number[]>(() => panes.map(() => 100 / panes.length))
    const containerRef = useRef<HTMLDivElement>(null)
    const draggingRef = useRef<{ index: number; startX: number; startSizes: number[] } | null>(null)
    const paneRefs = useRef<Record<string, React.RefObject<TerminalHandle | null>>>({})
    const chatRefs = useRef<Record<string, React.RefObject<ChatPanelHandle | null>>>({})

    const isChatPane = (pane: PaneProps): boolean => isChatSupported(pane.tab.mode)

    // Ensure a ref exists for each pane
    for (const pane of panes) {
      if (isChatPane(pane)) {
        if (!chatRefs.current[pane.tab.id]) {
          chatRefs.current[pane.tab.id] = { current: null }
        }
      } else if (!paneRefs.current[pane.sessionId]) {
        paneRefs.current[pane.sessionId] = { current: null }
      }
    }

    useImperativeHandle(ref, () => ({
      focus: (sessionId?: string) => {
        const id = sessionId ?? panes[0]?.sessionId
        if (!id) return
        const pane = panes.find((p) => p.sessionId === id)
        if (pane && isChatPane(pane)) {
          chatRefs.current[pane.tab.id]?.current?.focus()
        } else {
          paneRefs.current[id]?.current?.focus()
        }
      }
    }))

    // Reset sizes when pane count changes
    const prevCountRef = useRef(panes.length)
    if (panes.length !== prevCountRef.current) {
      prevCountRef.current = panes.length
      setSizes(panes.map(() => 100 / panes.length))
    }

    const handleMouseDown = useCallback(
      (index: number, e: React.MouseEvent) => {
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
      },
      [sizes]
    )

    const renderPane = (pane: PaneProps) => {
      if (isChatPane(pane)) {
        return (
          <Suspense fallback={<ChatPanelSkeleton />}>
            <ChatPanel
              ref={chatRefs.current[pane.tab.id]}
              key={pane.tab.id}
              tabId={pane.tab.id}
              taskId={pane.taskId}
              mode={pane.tab.mode}
              cwd={pane.cwd}
              isActive={isActive}
              providerFlagsOverride={pane.providerFlags ?? null}
              permissionNotice={pane.permissionNotice ?? null}
              onOpenUrl={onOpenUrl}
              onOpenFile={onOpenFile}
              wasSpawned={pane.tab.wasSpawned}
            />
          </Suspense>
        )
      }

      const hasContextMenu = pane.onSplit && pane.onNewGroup
      // Lazy-spawn gate: only the main AI-mode tab. Splits / extra groups /
      // plain `terminal` mode keep eager spawn (user-driven).
      const shouldGate = pane.tab.isMain && pane.tab.mode !== 'terminal'
      const TerminalCmp = shouldGate ? TerminalStarter : Terminal
      // `wasSpawned` (from terminal_tabs) tells TerminalStarter to auto-mount
      // instead of showing the Start chip — restores warm agents after a crash
      // or quit. Only meaningful when gating (Terminal ignores the prop).
      const terminal = (
        <TerminalCmp
          ref={paneRefs.current[pane.sessionId]}
          key={pane.sessionId}
          sessionId={pane.sessionId}
          cwd={pane.cwd}
          mode={pane.tab.mode}
          conversationId={pane.conversationId}
          existingConversationId={pane.existingConversationId}
          supportsSessionId={pane.supportsSessionId}
          initialPrompt={pane.initialPrompt}
          providerFlags={pane.providerFlags}
          executionContext={pane.executionContext}
          isActive={isActive}
          paused={paused}
          onAttached={onAttached}
          onStartFresh={pane.onStartFresh}
          onReady={pane.onReady}
          onFirstInput={pane.onFirstInput}
          onRetry={pane.onRetry}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
          {...(shouldGate
            ? {
                wasSpawned: pane.tab.wasSpawned,
                hibernated: pane.tab.hibernated,
                isTemporary: pane.isTemporary
              }
            : {})}
        />
      )

      if (!hasContextMenu) return terminal

      return (
        <TerminalContextMenu
          terminalRef={paneRefs.current[pane.sessionId]}
          sessionId={pane.sessionId}
          mode={pane.tab.mode}
          conversationId={pane.conversationId}
          onSplit={pane.onSplit!}
          onNewGroup={pane.onNewGroup!}
          onClose={pane.onClose ?? null}
          onRename={pane.onRename ?? null}
          onResetSession={pane.onResetSession ?? null}
        >
          <div className="h-full">{terminal}</div>
        </TerminalContextMenu>
      )
    }

    if (panes.length === 1) {
      const pane = panes[0]
      return (
        <div className="h-full" data-session-id={pane.sessionId}>
          {renderPane(pane)}
        </div>
      )
    }

    return (
      <div ref={containerRef} className="h-full flex">
        {panes.map((pane, i) => (
          <div
            key={pane.sessionId}
            className="flex"
            style={{ width: `${sizes[i]}%` }}
            data-session-id={pane.sessionId}
          >
            <div className="flex-1 min-w-0">{renderPane(pane)}</div>
            {i < panes.length - 1 && (
              <div
                className="w-1 cursor-col-resize bg-accent dark:bg-accent hover:bg-blue-400 dark:hover:bg-blue-500 transition-colors shrink-0"
                onMouseDown={(e) => handleMouseDown(i, e)}
              />
            )}
          </div>
        ))}
      </div>
    )
  }
)
