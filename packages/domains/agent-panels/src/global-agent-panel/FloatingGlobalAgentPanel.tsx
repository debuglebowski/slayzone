import { useState, useEffect, useCallback } from 'react'
import { Frame, X } from 'lucide-react'
import { Terminal } from '@slayzone/terminal/client/LazyTerminal'
import { useSessionState } from '@slayzone/terminal/client'
import type { TerminalMode } from '@slayzone/terminal/shared'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import { FloatingGlobalAgentPanelCollapsed } from './FloatingGlobalAgentPanelCollapsed'
import { FloatingGlobalAgentPanelCollapsedIcon } from './FloatingGlobalAgentPanelCollapsedIcon'

interface FloatingSession {
  sessionId: string
  cwd: string
  mode: TerminalMode
}

// Shapes returned by the floatingAgent.get* queries + onState subscription.
// The router types these procedures as `unknown` (app.ts floatingAgent.getState/
// getSession/getConfig/onState all return unknown), so the renderer applies the
// documented payload shapes locally — same contract the preload encoded before
// the cutover.
interface FloatingSessionPayload {
  sessionId: string
  cwd: string
  mode: string
}
interface FloatingConfigPayload {
  style: string
}
interface FloatingStatePayload {
  mode: 'auto' | 'manual' | null
  hasCustomSize: boolean
}

export function FloatingGlobalAgentPanel() {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [session, setSession] = useState<FloatingSession | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [style, setStyle] = useState<'widget' | 'icon'>('widget')
  const [showTerminal, setShowTerminal] = useState(false)
  const [detachMode, setDetachMode] = useState<'auto' | 'manual' | null>(null)
  const [hasCustomSize, setHasCustomSize] = useState(false)
  // Terminal state from the reactive store (hydrates this renderer on wire).
  const terminalState = useSessionState(session?.sessionId ?? '')

  const loadSessionAndConfig = useCallback(async () => {
    const data = (await trpcClient.app.floatingAgent.getSession.query()) as
      | FloatingSessionPayload
      | null
    if (data)
      setSession({ sessionId: data.sessionId, cwd: data.cwd, mode: data.mode as TerminalMode })
    const config = (await trpcClient.app.floatingAgent.getConfig.query()) as
      | FloatingConfigPayload
      | null
    if (config) setStyle(config.style as 'widget' | 'icon')
  }, [trpcClient])

  useEffect(() => {
    void loadSessionAndConfig()
  }, [loadSessionAndConfig])

  useSubscription(
    trpc.app.floatingAgent.onSessionChanged.subscriptionOptions(undefined, {
      onData: () => {
        void loadSessionAndConfig()
      }
    })
  )

  useSubscription(
    trpc.app.floatingAgent.onCollapseChanged.subscriptionOptions(undefined, {
      onData: ({ collapsed: c }) => {
        setCollapsed(c)
        if (c) {
          setShowTerminal(false)
        } else {
          setTimeout(() => setShowTerminal(true), 150)
        }
      }
    })
  )

  useEffect(() => {
    void trpcClient.app.floatingAgent.getState.query().then((raw) => {
      const s = raw as FloatingStatePayload
      setDetachMode(s.mode)
      setHasCustomSize(s.hasCustomSize)
    })
  }, [trpcClient])

  useSubscription(
    trpc.app.floatingAgent.onState.subscriptionOptions(undefined, {
      onData: (raw) => {
        const s = raw as FloatingStatePayload
        setDetachMode(s.mode)
        setHasCustomSize(s.hasCustomSize)
      }
    })
  )

  const handleToggle = useCallback(() => {
    trpcClient.app.floatingAgent.toggleCollapse.mutate()
  }, [trpcClient])

  const handleResetSize = useCallback(() => {
    trpcClient.app.floatingAgent.resetSize.mutate()
  }, [trpcClient])

  const handleClose = useCallback(() => {
    trpcClient.app.floatingAgent.reattach.mutate()
  }, [trpcClient])

  const showClose = detachMode === 'manual'
  const showReset = hasCustomSize

  if (collapsed) {
    if (style === 'icon') {
      return <FloatingGlobalAgentPanelCollapsedIcon state={terminalState} onExpand={handleToggle} />
    }
    return (
      <FloatingGlobalAgentPanelCollapsed
        state={terminalState}
        onExpand={handleToggle}
        onResetSize={handleResetSize}
        onClose={handleClose}
        showClose={showClose}
        showReset={showReset}
      />
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-1 overflow-hidden rounded-lg border border-border">
      <div
        className="shrink-0 h-7 flex items-center justify-between px-3 bg-surface-1 border-b border-border select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">
          Global Agent
        </span>
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
      <div
        className={`flex-1 min-h-0 transition-opacity duration-200${showTerminal ? ' opacity-100' : ' opacity-0'}`}
      >
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
