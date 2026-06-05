import { useEffect, type RefObject } from 'react'
import { nextAgentMode, type AgentMode, type AutoModeCapability } from '@slayzone/ui'
import { chatModesForMode } from '@slayzone/terminal/shared'
import type { CallbackRef } from './useFollowBottom'

export interface UseChatPanelKeyboardOpts {
  panelRef: RefObject<HTMLDivElement | null>
  scrollRef: CallbackRef<HTMLElement>
  search: { requestOpen: () => void }
  inFlight: boolean
  chatMode: AgentMode
  handleModeChange: (next: AgentMode) => Promise<unknown>
  autoCapability: AutoModeCapability
  autocomplete: { show: boolean }
  handleStop: () => void | Promise<void>
  mode: string
}

/**
 * Window-level keydown handler scoped to the chat panel that owns focus:
 *
 *   - Cmd/Ctrl+F → open in-chat search
 *   - Cmd/Ctrl+↑ / ↓ → jump timeline to top / bottom
 *   - Shift+Tab → cycle agent permission mode (terminal-mode parity; skipped
 *     while in flight or while autocomplete owns Tab)
 *   - Esc → stop the in-flight turn (defers to autocomplete's own Esc)
 *
 * Focus scoping matters: multiple chat tabs stay mounted (display:none) and a
 * window-level listener would otherwise fire in every panel at once. The
 * `isFocusedHere` heuristic claims ownership when an element inside this panel
 * is focused, or when nothing is focused (body) and this is the only visible
 * `[data-chat-panel]`.
 */
export function useChatPanelKeyboard({
  panelRef,
  scrollRef,
  search,
  inFlight,
  chatMode,
  handleModeChange,
  autoCapability,
  autocomplete,
  handleStop,
  mode
}: UseChatPanelKeyboardOpts): void {
  useEffect(() => {
    const isFocusedHere = (): boolean => {
      const root = panelRef.current
      if (!root) return false
      const active = document.activeElement
      // Active element inside the panel? OR the panel itself has focus?
      // Also accept body-focus (no element focused) when the panel is the only
      // visible chat panel — heuristic: treat panel as "owner" when no other
      // chat panel sibling is currently focus-receiving.
      if (active && root.contains(active)) return true
      if (active === document.body) {
        // Find the closest visible ChatPanel ancestor of any input — if none,
        // and this panel is visible, claim ownership.
        const visibleSelf = root.offsetParent !== null
        if (!visibleSelf) return false
        const others = document.querySelectorAll('[data-chat-panel]')
        for (const o of Array.from(others)) {
          if (o === root) continue
          const el = o as HTMLElement
          if (el.offsetParent !== null) return false // another panel also visible — defer
        }
        return true
      }
      return false
    }
    const handler = (e: KeyboardEvent): void => {
      if (!isFocusedHere()) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        search.requestOpen()
        return
      }
      if (mod && e.key === 'ArrowUp') {
        e.preventDefault()
        scrollRef.current?.scrollTo({ top: 0 })
        return
      }
      if (mod && e.key === 'ArrowDown') {
        e.preventDefault()
        const el = scrollRef.current
        if (el) el.scrollTo({ top: el.scrollHeight })
        return
      }
      // Shift+Tab cycles agent permission mode whenever the chat panel owns
      // focus — terminal-mode parity. Skipped while a turn is in flight (mode
      // change kills + respawns the subprocess) or while autocomplete consumes
      // Tab to accept the current selection.
      if (e.key === 'Tab' && e.shiftKey && !mod && !e.altKey) {
        if (autocomplete.show) return
        e.preventDefault()
        if (inFlight) return
        const next = nextAgentMode(chatMode, autoCapability.optedIn, chatModesForMode(mode))
        handleModeChange(next).catch(() => {
          /* toast already shown by hook */
        })
      }
      // Esc stops the in-flight turn — Claude CLI parity. Defers to autocomplete
      // (which uses Esc to close itself). No-op when nothing is in flight.
      if (e.key === 'Escape' && !mod && !e.altKey && !e.shiftKey) {
        if (autocomplete.show) return
        if (!inFlight) return
        e.preventDefault()
        void handleStop()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    scrollRef,
    search,
    inFlight,
    chatMode,
    handleModeChange,
    autoCapability.optedIn,
    autocomplete.show,
    handleStop
  ])
}
