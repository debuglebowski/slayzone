import { useState, useEffect, useCallback } from 'react'
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
  const [session, setSession] = useState<FloatingSession | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [style, setStyle] = useState<'widget' | 'icon'>('widget')
  const [terminalState, setTerminalState] = useState<TerminalState>('starting')
  const [showTerminal, setShowTerminal] = useState(false)
  const [detachMode, setDetachMode] = useState<'auto' | 'manual' | null>(null)
  const [hasCustomSize, setHasCustomSize] = useState(false)
  const { subscribeState, getState } = usePty()

  useEffect(() => {
    window.api.floatingGlobalAgentPanel.getSession().then((data) => {
      if (data) setSession({ sessionId: data.sessionId, cwd: data.cwd, mode: data.mode as TerminalMode })
    })
    window.api.floatingGlobalAgentPanel.getConfig().then((config) => {
      if (config) setStyle(config.style as 'widget' | 'icon')
    })
    const unsub = window.api.floatingGlobalAgentPanel.onSessionChanged(() => {
      window.api.floatingGlobalAgentPanel.getSession().then((data) => {
        if (data) setSession({ sessionId: data.sessionId, cwd: data.cwd, mode: data.mode as TerminalMode })
      })
      window.api.floatingGlobalAgentPanel.getConfig().then((config) => {
        if (config) setStyle(config.style as 'widget' | 'icon')
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    return window.api.floatingGlobalAgentPanel.onCollapseChanged((c) => {
      setCollapsed(c)
      if (c) {
        setShowTerminal(false)
      } else {
        setTimeout(() => setShowTerminal(true), 150)
      }
    })
  }, [])

  useEffect(() => {
    window.api.floatingGlobalAgentPanel.getState().then((s) => {
      setDetachMode(s.mode)
      setHasCustomSize(s.hasCustomSize)
    })
    return window.api.floatingGlobalAgentPanel.onState((s) => {
      setDetachMode(s.mode)
      setHasCustomSize(s.hasCustomSize)
    })
  }, [])

  useEffect(() => {
    if (!session) return
    const contextState = getState(session.sessionId)
    if (contextState !== 'starting') {
      setTerminalState(contextState)
    } else {
      window.api.pty.getState(session.sessionId).then((backendState) => {
        if (backendState) setTerminalState(backendState)
      })
    }
    return subscribeState(session.sessionId, (newState) => {
      setTerminalState(newState)
    })
  }, [session, getState, subscribeState])

  const handleToggle = useCallback(() => {
    window.api.floatingGlobalAgentPanel.toggleCollapse()
  }, [])

  const handleResetSize = useCallback(() => {
    window.api.floatingGlobalAgentPanel.resetSize()
  }, [])

  const handleClose = useCallback(() => {
    window.api.floatingGlobalAgentPanel.reattach()
  }, [])

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
