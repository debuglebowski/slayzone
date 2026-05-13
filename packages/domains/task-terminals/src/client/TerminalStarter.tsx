import { useState, useEffect, forwardRef, useRef, useImperativeHandle } from 'react'
import { Play } from 'lucide-react'
import { Terminal, type TerminalHandle, type TerminalProps } from '@slayzone/terminal/client/LazyTerminal'
import { useTheme } from '@slayzone/settings/client'
import { getThemeTerminalColors } from '@slayzone/ui'
import { MODE_ICONS } from './TerminalTabBar'
import { getModeLabel } from './get-tab-label'

// Lazy-spawn wrapper: hold off mounting <Terminal> (and thus PTY creation)
// until the user explicitly clicks Start. Reattach to an already-alive PTY
// skips the gate so multi-window / hibernation flows are unchanged.
export const TerminalStarter = forwardRef<TerminalHandle, TerminalProps>(function TerminalStarter(props, ref) {
  const { sessionId, mode = 'claude-code' } = props
  const [started, setStarted] = useState(false)
  const [existsChecked, setExistsChecked] = useState(false)
  const innerRef = useRef<TerminalHandle | null>(null)
  const { terminalThemeId, contentVariant } = useTheme()
  const themeColors = getThemeTerminalColors(terminalThemeId, contentVariant)

  // If a PTY already exists for this sessionId (hibernation resume, multi-window
  // reattach), skip the gate — `pty.exists` is the same probe Terminal.tsx uses.
  // Gate first paint behind this check so reattach doesn't flash the Start chip.
  useEffect(() => {
    let cancelled = false
    void window.api.pty.exists(sessionId).then((exists) => {
      if (cancelled) return
      if (exists) setStarted(true)
      setExistsChecked(true)
    })
    return () => { cancelled = true }
  }, [sessionId])

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
    return <Terminal {...props} ref={innerRef} />
  }

  // Suppress paint until exists-check resolves; avoids Start-chip flash on
  // reattach paths (hibernation resume, multi-window).
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

  return (
    <div
      className="h-full w-full flex items-center justify-center"
      style={{ backgroundColor: themeColors.background ?? '#0a0a0a' }}
    >
      <button
        type="button"
        autoFocus
        onClick={() => setStarted(true)}
        className="flex items-center gap-2 rounded-md border border-border bg-surface-1 hover:bg-surface-2 px-4 py-2 text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {Icon ? <Icon className="size-4" /> : <Play className="size-4" />}
        Start {label}
      </button>
    </div>
  )
})
