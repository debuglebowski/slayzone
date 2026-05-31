import { useState, useEffect, forwardRef, useRef, useImperativeHandle } from 'react'
import { Play, Moon } from 'lucide-react'
import {
  Terminal,
  type TerminalHandle,
  type TerminalProps
} from '@slayzone/terminal/client/LazyTerminal'
import { markSkipCache } from '@slayzone/terminal/client'
import { useTheme } from '@slayzone/settings/client'
import { getThemeTerminalColors, useVisibleInterval } from '@slayzone/ui'
import { MODE_ICONS } from './TerminalTabBar'
import { getModeLabel } from './get-tab-label'

export interface TerminalStarterProps extends TerminalProps {
  /**
   * Hint from `terminal_tabs.was_spawned`: the agent was alive when the app
   * last touched this tab (set on spawn, cleared on natural/user exit, NOT
   * cleared on app shutdown). True → skip the Start gate and auto-spawn so
   * the user lands in their warm state without clicking Start again.
   */
  wasSpawned?: boolean
  /**
   * Persisted idle-close status (`terminal_tabs.hibernated`). True → the agent
   * was auto-closed while idle; show the "Reopen … (resumes)" screen instead of
   * auto-mounting, even across reload/restart.
   */
  hibernated?: boolean
}

// Lazy-spawn wrapper: hold off mounting <Terminal> (and thus PTY creation)
// until the user explicitly clicks Start. Reattach to an already-alive PTY
// skips the gate so multi-window / hibernation flows are unchanged. The
// `wasSpawned` hint also skips the gate so warm-set restoration on next boot
// (after crash or quit) brings the agent back without user action.
export const TerminalStarter = forwardRef<TerminalHandle, TerminalStarterProps>(
  function TerminalStarter(props, ref) {
    const { sessionId, mode = 'claude-code', wasSpawned, hibernated, ...terminalProps } = props
    const [started, setStarted] = useState(false)
    const [existsChecked, setExistsChecked] = useState(false)
    const [dontShowAgain, setDontShowAgain] = useState(false)
    // Why the Start screen is showing: 'initial' (never started / auto-start
    // off) vs 'hibernated' (idle-close killed it). Drives copy + the
    // "Don't show again" checkbox semantics.
    const [reason, setReason] = useState<'initial' | 'hibernated'>('initial')
    // Seconds left in the idle-close countdown (null = not counting down).
    const [countdown, setCountdown] = useState<number | null>(null)
    const innerRef = useRef<TerminalHandle | null>(null)
    const { terminalThemeId, contentVariant } = useTheme()
    const themeColors = getThemeTerminalColors(terminalThemeId, contentVariant)

    useEffect(() => {
      let cancelled = false
      // Persisted hibernation wins: show the "Reopen … (resumes)" screen, don't
      // auto-mount — survives reload/restart so a stale agent stays distinct.
      if (hibernated) {
        setReason('hibernated')
        setStarted(false)
        setExistsChecked(true)
        return () => {
          cancelled = true
        }
      }
      if (wasSpawned) {
        setStarted(true)
        setExistsChecked(true)
        return () => {
          cancelled = true
        }
      }
      void Promise.all([
        window.api.pty.exists(sessionId),
        window.api.settings.get('terminal_auto_start')
      ]).then(([exists, autoStart]) => {
        if (cancelled) return
        if (exists || autoStart === '1') setStarted(true)
        setExistsChecked(true)
      })
      return () => {
        cancelled = true
      }
    }, [sessionId, wasSpawned, hibernated])

    // Idle-close (hibernation) signals from main. `warn` arms a visual
    // countdown; `cancelled` aborts it; `hibernated` means main killed the PTY
    // → swap to the Start screen (reopen resumes via conversation id).
    useEffect(() => {
      const offWarn = window.api.pty.onHibernateWarn((sid, graceSeconds) => {
        if (sid !== sessionId) return
        setCountdown(graceSeconds)
      })
      const offCancelled = window.api.pty.onHibernateCancelled((sid) => {
        if (sid !== sessionId) return
        setCountdown(null)
      })
      const offHibernated = window.api.pty.onHibernated((sid) => {
        if (sid !== sessionId) return
        setCountdown(null)
        // Dispose (don't cache) the dead xterm so reopen builds a fresh one
        // showing the resumed session.
        markSkipCache(sessionId)
        setReason('hibernated')
        setExistsChecked(true)
        setStarted(false)
      })
      return () => {
        offWarn()
        offCancelled()
        offHibernated()
      }
    }, [sessionId])

    useVisibleInterval(
      () =>
        setCountdown((c) => {
          if (c === null) return null
          if (c <= 1) return 0
          return c - 1
        }),
      1000,
      { enabled: countdown !== null && countdown > 0 }
    )

    useImperativeHandle(
      ref,
      () => ({
        focus: () => innerRef.current?.focus(),
        hasSelection: () => innerRef.current?.hasSelection() ?? false,
        getSelection: () => innerRef.current?.getSelection() ?? '',
        selectAll: () => innerRef.current?.selectAll(),
        scrollToBottom: () => innerRef.current?.scrollToBottom(),
        openSearch: () => innerRef.current?.openSearch(),
        clearBuffer: async () => {
          await innerRef.current?.clearBuffer()
        }
      }),
      []
    )

    const label = getModeLabel(mode)

    if (started) {
      const handleCancelCountdown = (): void => {
        setCountdown(null)
        void window.api.pty.touch(sessionId)
      }
      return (
        <div className="relative h-full w-full">
          <Terminal {...terminalProps} sessionId={sessionId} mode={mode} ref={innerRef} />
          {countdown !== null && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3 whitespace-nowrap rounded-xl bg-orange-500/25 px-5 py-3 text-white shadow-lg ring-1 ring-orange-400/30 backdrop-blur-md">
              <Moon className="size-6 shrink-0 animate-pulse" />
              <span className="text-sm">
                Closing idle {label} in{' '}
                <span className="text-lg font-bold tabular-nums">{countdown}s</span>
              </span>
              <button
                type="button"
                onClick={handleCancelCountdown}
                className="ml-1 rounded-lg bg-white px-3.5 py-1.5 text-sm font-semibold text-black hover:bg-orange-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Keep open
              </button>
            </div>
          )}
        </div>
      )
    }

    if (!existsChecked) {
      return (
        <div
          className="h-full w-full"
          style={{ backgroundColor: themeColors.background ?? '#0a0a0a' }}
        />
      )
    }

    const Icon = MODE_ICONS[mode]
    const isHibernated = reason === 'hibernated'

    const handleStart = () => {
      if (dontShowAgain) {
        // The checkbox disables whichever feature put us on this screen.
        if (isHibernated) void window.api.settings.set('terminal_auto_close_idle', '0')
        else void window.api.settings.set('terminal_auto_start', '1')
      }
      setReason('initial')
      setStarted(true)
    }

    return (
      <div
        className="h-full w-full flex flex-col items-center justify-center gap-6 px-6"
        style={{ backgroundColor: themeColors.background ?? '#0a0a0a' }}
      >
        <div className="space-y-2 text-center max-w-md">
          <h2 className="text-2xl font-semibold text-foreground">
            {isHibernated ? `${label} closed to save memory` : `${label} is idle`}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isHibernated
              ? 'It sat idle, so it was closed. Reopen to resume the conversation.'
              : 'Saves CPU and API credits until you start it.'}
          </p>
        </div>
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            autoFocus
            onClick={handleStart}
            className="flex items-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground hover:bg-surface-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {Icon ? <Icon className="size-4" /> : <Play className="size-4" />}
            {isHibernated ? `Reopen ${label}` : `Open ${label}`}
          </button>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="cursor-pointer"
            />
            <span>{isHibernated ? "Don't auto-close this agent" : "Don't show this again"}</span>
          </label>
        </div>
      </div>
    )
  }
)
