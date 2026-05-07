import { useState, useEffect, useCallback } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { Frame, X } from 'lucide-react'
import { Terminal } from '@slayzone/terminal/client/LazyTerminal'
import { usePty } from '@slayzone/terminal/client'
import type { TerminalMode, TerminalState } from '@slayzone/terminal/shared'
import { FloatingAgentCollapsed } from './FloatingAgentCollapsed'
import { FloatingAgentCollapsedIcon } from './FloatingAgentCollapsedIcon'

interface FloatingSession {
  sessionId: string
  cwd: string
  mode: TerminalMode
}

export function FloatingAgentPanel() {
  const [session, setSession] = useState<FloatingSession | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [style, setStyle] = useState<'widget' | 'icon'>('widget')
  const [terminalState, setTerminalState] = useState<TerminalState>('starting')
  const [showTerminal, setShowTerminal] = useState(false)
  const [detachMode, setDetachMode] = useState<'auto' | 'manual' | null>(null)
  const [hasCustomSize, setHasCustomSize] = useState(false)
  const { subscribeState, getState } = usePty()

  useEffect(() => {
    getTrpcVanillaClient().app.floatingAgent.getSession.query().then((data) => {
      if (data) {
        const d = data as { sessionId: string; cwd: string; mode: string }
        setSession({ sessionId: d.sessionId, cwd: d.cwd, mode: d.mode as TerminalMode })
      }
    })
    getTrpcVanillaClient().app.floatingAgent.getConfig.query().then((config) => {
      if (config) setStyle((config as { style: string }).style as 'widget' | 'icon')
    })
    const sub = getTrpcVanillaClient().app.floatingAgent.onSessionChanged.subscribe(undefined, {
      onData: () => {
        getTrpcVanillaClient().app.floatingAgent.getSession.query().then((data) => {
          if (data) {
            const d = data as { sessionId: string; cwd: string; mode: string }
            setSession({ sessionId: d.sessionId, cwd: d.cwd, mode: d.mode as TerminalMode })
          }
        })
        getTrpcVanillaClient().app.floatingAgent.getConfig.query().then((config) => {
          if (config) setStyle((config as { style: string }).style as 'widget' | 'icon')
        })
      },
    })
    return () => sub.unsubscribe()
  }, [])

  useEffect(() => {
    const sub = getTrpcVanillaClient().app.floatingAgent.onCollapseChanged.subscribe(undefined, {
      onData: ({ collapsed: c }) => {
        setCollapsed(c)
        if (c) {
          setShowTerminal(false)
        } else {
          setTimeout(() => setShowTerminal(true), 150)
        }
      },
    })
    return () => sub.unsubscribe()
  }, [])

  useEffect(() => {
    getTrpcVanillaClient().app.floatingAgent.getState.query().then((s) => {
      const st = s as { mode: 'auto' | 'manual' | null; hasCustomSize: boolean }
      setDetachMode(st.mode)
      setHasCustomSize(st.hasCustomSize)
    })
    const sub = getTrpcVanillaClient().app.floatingAgent.onState.subscribe(undefined, {
      onData: (s) => {
        const st = s as { mode: 'auto' | 'manual' | null; hasCustomSize: boolean }
        setDetachMode(st.mode)
        setHasCustomSize(st.hasCustomSize)
      },
    })
    return () => sub.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    const contextState = getState(session.sessionId)
    if (contextState !== 'starting') {
      setTerminalState(contextState)
    } else {
      getTrpcVanillaClient().pty.getState.query({ sessionId: session.sessionId }).then((backendState) => {
        if (backendState) setTerminalState(backendState)
      })
    }
    return subscribeState(session.sessionId, (newState) => {
      setTerminalState(newState)
    })
  }, [session, getState, subscribeState])

  const handleToggle = useCallback(() => {
    getTrpcVanillaClient().app.floatingAgent.toggleCollapse.mutate()
  }, [])

  const handleResetSize = useCallback(() => {
    getTrpcVanillaClient().app.floatingAgent.resetSize.mutate()
  }, [])

  const handleClose = useCallback(() => {
    getTrpcVanillaClient().app.floatingAgent.reattach.mutate()
  }, [])

  const showClose = detachMode === 'manual'
  const showReset = hasCustomSize

  if (collapsed) {
    if (style === 'icon') {
      return <FloatingAgentCollapsedIcon state={terminalState} onExpand={handleToggle} />
    }
    return <FloatingAgentCollapsed state={terminalState} onExpand={handleToggle} onResetSize={handleResetSize} onClose={handleClose} showClose={showClose} showReset={showReset} />
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-1 overflow-hidden rounded-lg border border-border">
      <div
        className="shrink-0 h-7 flex items-center justify-between px-3 bg-surface-1 border-b border-border select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">Agent</span>
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
