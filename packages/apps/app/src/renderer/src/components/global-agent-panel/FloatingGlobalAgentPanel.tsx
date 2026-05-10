import { useState, useEffect, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Frame, X } from 'lucide-react'
import { Terminal } from '@slayzone/terminal/client/LazyTerminal'
import { usePty } from '@slayzone/terminal/client'
import type { TerminalMode, TerminalState } from '@slayzone/terminal/shared'
import { FloatingGlobalAgentPanelCollapsed } from './FloatingGlobalAgentPanelCollapsed'
import { FloatingGlobalAgentPanelCollapsedIcon } from './FloatingGlobalAgentPanelCollapsedIcon'

interface FloatingSession {
  sessionId: string
  cwd: string
  mode: TerminalMode
}

export function FloatingGlobalAgentPanel() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const sessionQuery = useQuery(trpc.app.floatingGlobalAgentPanel.getSession.queryOptions())
  const sessionData = sessionQuery.data as unknown as { sessionId: string; cwd: string; mode: string } | null | undefined
  const session: FloatingSession | null = sessionData
    ? { sessionId: sessionData.sessionId, cwd: sessionData.cwd, mode: sessionData.mode as TerminalMode }
    : null

  const configQuery = useQuery(trpc.app.floatingGlobalAgentPanel.getConfig.queryOptions())
  const configData = configQuery.data as unknown as { style?: string } | null | undefined
  const style: 'widget' | 'icon' = (configData?.style as 'widget' | 'icon') ?? 'widget'

  const stateQuery = useQuery(trpc.app.floatingGlobalAgentPanel.getState.queryOptions())
  const stateData = stateQuery.data as unknown as { mode?: 'auto' | 'manual' | null; hasCustomSize?: boolean } | null | undefined
  const detachMode: 'auto' | 'manual' | null = stateData?.mode ?? null
  const hasCustomSize: boolean = !!stateData?.hasCustomSize

  const [collapsed, setCollapsed] = useState(true)
  const [terminalState, setTerminalState] = useState<TerminalState>('starting')
  const [showTerminal, setShowTerminal] = useState(false)
  const { subscribeState, getState } = usePty()

  // Re-fetch session + config when the server fires onSessionChanged.
  useSubscription(
    trpc.app.floatingGlobalAgentPanel.onSessionChanged.subscriptionOptions(undefined, {
      onData: () => {
        queryClient.invalidateQueries({ queryKey: trpc.app.floatingGlobalAgentPanel.getSession.queryKey() })
        queryClient.invalidateQueries({ queryKey: trpc.app.floatingGlobalAgentPanel.getConfig.queryKey() })
      },
    }),
  )

  // Collapse state is owned by the main process (drives window resizing). Mirror to local state.
  useSubscription(
    trpc.app.floatingGlobalAgentPanel.onCollapseChanged.subscriptionOptions(undefined, {
      onData: ({ collapsed: c }) => {
        setCollapsed(c)
        if (c) {
          setShowTerminal(false)
        } else {
          setTimeout(() => setShowTerminal(true), 150)
        }
      },
    }),
  )

  // Detach state changes invalidate the cached state query.
  useSubscription(
    trpc.app.floatingGlobalAgentPanel.onState.subscriptionOptions(undefined, {
      onData: () => {
        queryClient.invalidateQueries({ queryKey: trpc.app.floatingGlobalAgentPanel.getState.queryKey() })
      },
    }),
  )

  useEffect(() => {
    if (!session) return
    const contextState = getState(session.sessionId)
    if (contextState !== 'starting') {
      setTerminalState(contextState)
    } else {
      queryClient.fetchQuery(trpc.pty.getState.queryOptions({ sessionId: session.sessionId })).then((backendState) => {
        if (backendState) setTerminalState(backendState)
      })
    }
    return subscribeState(session.sessionId, (newState) => {
      setTerminalState(newState)
    })
  }, [session, getState, subscribeState, queryClient, trpc])

  const toggleCollapse = useMutation(trpc.app.floatingGlobalAgentPanel.toggleCollapse.mutationOptions())
  const resetSize = useMutation(trpc.app.floatingGlobalAgentPanel.resetSize.mutationOptions())
  const reattach = useMutation(trpc.app.floatingGlobalAgentPanel.reattach.mutationOptions())

  const handleToggle = useCallback(() => { toggleCollapse.mutate() }, [toggleCollapse])
  const handleResetSize = useCallback(() => { resetSize.mutate() }, [resetSize])
  const handleClose = useCallback(() => { reattach.mutate() }, [reattach])

  const showClose = detachMode === 'manual'
  const showReset = hasCustomSize

  if (collapsed) {
    if (style === 'icon') {
      return <FloatingGlobalAgentPanelCollapsedIcon state={terminalState} onExpand={handleToggle} />
    }
    return <FloatingGlobalAgentPanelCollapsed state={terminalState} onExpand={handleToggle} onResetSize={handleResetSize} onClose={handleClose} showClose={showClose} showReset={showReset} />
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-1 overflow-hidden rounded-lg border border-border">
      <div
        className="shrink-0 h-7 flex items-center justify-between px-3 bg-surface-1 border-b border-border select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">Global Agent</span>
        <div className="flex items-center gap-0.5">
          {showReset && (
            <button
              className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onClick={handleResetSize}
              title="Reset size & position"
              aria-label="Reset size and position"
            >
              <Frame className="size-3" />
            </button>
          )}
          <button
            className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={handleToggle}
            title="Minimize"
            aria-label="Minimize"
          >
            &#x2014;
          </button>
          {showClose && (
            <button
              className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-red-500/20 hover:text-red-500 transition-colors"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onClick={handleClose}
              title="Close (reattach to sidebar)"
              aria-label="Close"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>
      <div className={`flex-1 min-h-0 transition-opacity duration-200${showTerminal ? ' opacity-100' : ' opacity-0'}`}>
        {session && showTerminal ? (
          <Terminal
            key={session.sessionId}
            sessionId={session.sessionId}
            cwd={session.cwd}
            mode={session.mode}
            isActive={true}
          />
        ) : (
          <div className="h-full bg-black" />
        )}
      </div>
    </div>
  )
}
