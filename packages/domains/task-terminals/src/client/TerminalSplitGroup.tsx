import {
  useState,
  useCallback,
  useRef,
  forwardRef,
  useImperativeHandle,
  lazy,
  Suspense
} from 'react'
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
import { createHandleRefRegistry, handleRefFor } from './handle-ref-registry'

interface PaneProps {
  tab: TerminalTab
  taskId: string
  sessionId: string
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  /** True once the conversation id is hydrated; gates the main tab's auto-spawn. */
  conversationHydrated?: boolean
  supportsSessionId?: boolean
  providerFlags?: string
  executionContext?: import('@slayzone/terminal-contracts').ExecutionContext | null
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
  /** The main agent's hand-off ("Continue in chat" / "Continue in terminal"). */
  onHandoff?: (() => void) | null
  /** Open the task's sessions sidebar (absent: nothing to pick from). */
  onShowSessions?: (() => void) | null
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
    // Terminal handles keyed by sessionId, chat handles by tab id.
    const [paneRefs] = useState(createHandleRefRegistry<TerminalHandle>)
    const [chatRefs] = useState(createHandleRefRegistry<ChatPanelHandle>)

    const isChatPane = (pane: PaneProps): boolean => isChatSupported(pane.tab.mode)

    useImperativeHandle(ref, () => ({
      focus: (sessionId?: string) => {
        const id = sessionId ?? panes[0]?.sessionId
        if (!id) return
        const pane = panes.find((p) => p.sessionId === id)
        if (pane && isChatPane(pane)) {
          chatRefs.get(pane.tab.id)?.current?.focus()
        } else {
          paneRefs.get(id)?.current?.focus()
        }
      }
    }))

    // Reset sizes when pane count changes
    const [prevCount, setPrevCount] = useState(panes.length)
    if (panes.length !== prevCount) {
      setPrevCount(panes.length)
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
              ref={handleRefFor(chatRefs, pane.tab.id)}
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
              agentState={pane.tab.agentState}
              isMain={pane.tab.isMain}
              isTemporary={pane.isTemporary}
              {...(pane.onHandoff ? { onHandoff: pane.onHandoff } : {})}
              {...(pane.onShowSessions ? { onShowSessions: pane.onShowSessions } : {})}
            />
          </Suspense>
        )
      }

      const hasContextMenu = pane.onSplit && pane.onNewGroup
      const terminalRef = handleRefFor(paneRefs, pane.sessionId)
      // Lazy-spawn gate: only the main AI-mode tab. Splits / extra groups /
      // plain `terminal` mode keep eager spawn (user-driven).
      const shouldGate = pane.tab.isMain && pane.tab.mode !== 'terminal'
      const TerminalCmp = shouldGate ? TerminalStarter : Terminal
      // `agentState` (from terminal_tabs) + the startup mode tell TerminalStarter
      // whether to auto-mount instead of showing the Start chip — e.g. restores
      // warm agents after a crash or quit. Only meaningful when gating.
      const terminal = (
        <TerminalCmp
          ref={terminalRef}
          key={pane.sessionId}
          sessionId={pane.sessionId}
          cwd={pane.cwd}
          mode={pane.tab.mode}
          conversationId={pane.conversationId}
          existingConversationId={pane.existingConversationId}
          supportsSessionId={pane.supportsSessionId}
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
                agentState: pane.tab.agentState,
                isTemporary: pane.isTemporary,
                conversationHydrated: pane.conversationHydrated
              }
            : {})}
        />
      )

      if (!hasContextMenu) return terminal

      return (
        <TerminalContextMenu
          terminalRef={terminalRef}
          sessionId={pane.sessionId}
          mode={pane.tab.mode}
          conversationId={pane.conversationId}
          onSplit={pane.onSplit!}
          onNewGroup={pane.onNewGroup!}
          onClose={pane.onClose ?? null}
          onRename={pane.onRename ?? null}
          onResetSession={pane.onResetSession ?? null}
          onHandoff={pane.onHandoff ?? null}
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
