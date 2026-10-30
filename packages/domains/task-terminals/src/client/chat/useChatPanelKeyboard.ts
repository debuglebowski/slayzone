import { useEffect, type RefObject } from 'react'
import { nextAgentMode, type AgentMode, type AutoModeCapability } from '@slayzone/ui'
import { chatModesForMode } from '@slayzone/terminal-contracts'
import type { CallbackRef } from './useFollowBottom'
import { isTypingTarget, type PromptKeyHandler } from './prompts/prompt-keys'

/** The TUI's double-press window (Claude Code 2.1.314: 800 ms). */
export const DOUBLE_ESC_MS = 800

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
  /**
   * The prompt dock's key handler while a prompt waits (`prompts/prompt-keys.ts`).
   * It sees every key first; a key it consumes means nothing else here (Esc
   * answers the prompt instead of stopping the turn).
   */
  promptKeysRef?: RefObject<PromptKeyHandler | null>
  /** The composer's textarea: Esc Esc counts from it, or from no field at all. */
  composerRef?: RefObject<HTMLTextAreaElement | null>
  /** The composer holds nothing (no text, no files). */
  draftEmpty?: boolean
  /**
   * Esc Esc with no turn running and an empty composer — the TUI's double-Esc,
   * which opens rewind. Absent: Esc Esc means nothing (no rewind).
   */
  onDoubleEscape?: () => void
  /** Scroll to the previous (-1) or next (1) user turn (the turn outline's keys). */
  jumpTurn?: (dir: -1 | 1) => void
  /** Cmd+↓: to the end AND follow it again (`useFollowBottom.scrollToBottom`). */
  scrollToBottom?: () => void
}

/**
 * Window-level keydown handler scoped to the chat panel that owns focus:
 *
 *   - Cmd/Ctrl+F → open in-chat search
 *   - Cmd/Ctrl+↑ / ↓ → jump timeline to top / bottom
 *   - Cmd+Alt+↑ / ↓ (macOS) or Alt+PgUp / PgDn → previous / next user turn
 *     (Ctrl+Alt+arrows is the desktop's workspace switch on Windows / Linux)
 *   - Shift+Tab → cycle agent permission mode (terminal-mode parity; skipped
 *     while in flight or while autocomplete owns Tab)
 *   - Esc → stop the in-flight turn (defers to autocomplete's own Esc)
 *   - Esc Esc (within 800 ms, no turn running, empty composer, from the composer
 *     or no field) → rewind (`onDoubleEscape`), like the TUI. With text in the
 *     composer it does nothing: typed text is never lost.
 *   - a pending prompt's keys (1/2/3, ↑/↓, Enter, Esc, Tab) go to the prompt
 *     dock first
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
  mode,
  promptKeysRef,
  composerRef,
  draftEmpty = false,
  onDoubleEscape,
  jumpTurn,
  scrollToBottom
}: UseChatPanelKeyboardOpts): void {
  useEffect(() => {
    // When the last Esc that could start a double-Esc was pressed (0: none).
    let armedAt = 0
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
      if (e.key !== 'Escape') armedAt = 0
      // A key a field already handled (the prompt's feedback Enter / Esc) is
      // not the prompt's.
      if (!e.defaultPrevented && !autocomplete.show && promptKeysRef?.current?.(e)) {
        e.preventDefault()
        return
      }
      const mod = e.metaKey || e.ctrlKey
      const turnDir =
        e.altKey && !e.shiftKey && !e.ctrlKey
          ? e.metaKey
            ? e.key === 'ArrowUp'
              ? -1
              : e.key === 'ArrowDown'
                ? 1
                : 0
            : e.key === 'PageUp'
              ? -1
              : e.key === 'PageDown'
                ? 1
                : 0
          : 0
      if (turnDir !== 0 && jumpTurn) {
        e.preventDefault()
        jumpTurn(turnDir)
        return
      }
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
        if (scrollToBottom) {
          scrollToBottom()
          return
        }
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
        if (inFlight) {
          armedAt = 0
          e.preventDefault()
          void handleStop()
          return
        }
        const active = document.activeElement
        const fromComposer = active === composerRef?.current || !isTypingTarget(active)
        if (!onDoubleEscape || e.defaultPrevented || !draftEmpty || !fromComposer) {
          armedAt = 0
          return
        }
        const now = Date.now()
        if (armedAt > 0 && now - armedAt <= DOUBLE_ESC_MS) {
          armedAt = 0
          e.preventDefault()
          onDoubleEscape()
        } else {
          armedAt = now
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    panelRef,
    scrollRef,
    search,
    inFlight,
    chatMode,
    handleModeChange,
    autoCapability.optedIn,
    autocomplete.show,
    handleStop,
    mode,
    promptKeysRef,
    composerRef,
    draftEmpty,
    onDoubleEscape,
    jumpTurn,
    scrollToBottom
  ])
}
