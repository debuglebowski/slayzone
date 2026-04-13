import { useState, useEffect, useCallback } from 'react'
import { Terminal } from '@slayzone/terminal/client/Terminal'
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
  const { subscribeState, getState } = usePty()

  useEffect(() => {
    window.api.floatingAgent.getSession().then((data) => {
      if (data) setSession({ sessionId: data.sessionId, cwd: data.cwd, mode: data.mode as TerminalMode })
    })
    window.api.floatingAgent.getConfig().then((config) => {
      if (config) setStyle(config.style as 'widget' | 'icon')
    })
    const unsub = window.api.floatingAgent.onSessionChanged(() => {
      window.api.floatingAgent.getSession().then((data) => {
        if (data) setSession({ sessionId: data.sessionId, cwd: data.cwd, mode: data.mode as TerminalMode })
      })
      window.api.floatingAgent.getConfig().then((config) => {
        if (config) setStyle(config.style as 'widget' | 'icon')
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    return window.api.floatingAgent.onCollapseChanged((c) => {
      setCollapsed(c)
      if (c) {
        setShowTerminal(false)
      } else {
        setTimeout(() => setShowTerminal(true), 150)
      }
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
    window.api.floatingAgent.toggleCollapse()
  }, [])

  if (collapsed) {
    if (style === 'icon') {
      return <FloatingAgentCollapsedIcon state={terminalState} onExpand={handleToggle} />
    }
    return <FloatingAgentCollapsed state={terminalState} onExpand={handleToggle} />
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-1 overflow-hidden rounded-lg border border-border">
      <div
        className="shrink-0 h-7 flex items-center justify-between px-3 bg-surface-1 border-b border-border select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">Agent</span>
        <button
          className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={handleToggle}
          title="Minimize"
        >
          &#x2014;
        </button>
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
