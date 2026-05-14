import { useState, useEffect, forwardRef, useRef, useImperativeHandle } from 'react'
import { Play } from 'lucide-react'
import { Terminal, type TerminalHandle, type TerminalProps } from '@slayzone/terminal/client/LazyTerminal'
import { useTheme } from '@slayzone/settings/client'
import { getThemeTerminalColors } from '@slayzone/ui'
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
}

// Lazy-spawn wrapper: hold off mounting <Terminal> (and thus PTY creation)
// until the user explicitly clicks Start. Reattach to an already-alive PTY
// skips the gate so multi-window / hibernation flows are unchanged. The
// `wasSpawned` hint also skips the gate so warm-set restoration on next boot
// (after crash or quit) brings the agent back without user action.
export const TerminalStarter = forwardRef<TerminalHandle, TerminalStarterProps>(function TerminalStarter(props, ref) {
  const { sessionId, mode = 'claude-code', wasSpawned, ...terminalProps } = props
  const [started, setStarted] = useState(false)
  const [existsChecked, setExistsChecked] = useState(false)
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const innerRef = useRef<TerminalHandle | null>(null)
  const { terminalThemeId, contentVariant } = useTheme()
  const themeColors = getThemeTerminalColors(terminalThemeId, contentVariant)

  useEffect(() => {
    let cancelled = false
    if (wasSpawned) {
      setStarted(true)
      setExistsChecked(true)
      return () => { cancelled = true }
    }
    void Promise.all([
      window.api.pty.exists(sessionId),
      window.api.settings.get('terminal_auto_start'),
    ]).then(([exists, autoStart]) => {
      if (cancelled) return
      if (exists || autoStart === '1') setStarted(true)
      setExistsChecked(true)
    })
    return () => { cancelled = true }
  }, [sessionId, wasSpawned])

  useImperativeHandle(ref, () => ({
    focus: () => innerRef.current?.focus(),
    hasSelection: () => innerRef.current?.hasSelection() ?? false,
    getSelection: () => innerRef.current?.getSelection() ?? '',
    selectAll: () => innerRef.current?.selectAll(),
    scrollToBottom: () => innerRef.current?.scrollToBottom(),
    openSearch: () => innerRef.current?.openSearch(),
    clearBuffer: async () => { await innerRef.current?.clearBuffer() }
  }), [])

  if (started) {
    return <Terminal {...terminalProps} sessionId={sessionId} mode={mode} ref={innerRef} />
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
  const label = getModeLabel(mode)

  const handleStart = () => {
    if (dontShowAgain) void window.api.settings.set('terminal_auto_start', '1')
    setStarted(true)
  }

  return (
    <div
      className="h-full w-full flex flex-col items-center justify-center gap-6 px-6"
      style={{ backgroundColor: themeColors.background ?? '#0a0a0a' }}
    >
      <div className="space-y-2 text-center max-w-md">
        <h2 className="text-2xl font-semibold text-foreground">{label} is idle</h2>
        <p className="text-sm text-muted-foreground">
          Saves CPU and API credits until you start it.
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
          Start {label}
        </button>
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="cursor-pointer"
          />
          <span>Don&rsquo;t show this again</span>
        </label>
      </div>
    </div>
  )
})
