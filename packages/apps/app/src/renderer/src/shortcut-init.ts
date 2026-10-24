import { registry, scopeTracker } from '@slayzone/shortcuts'
import { isModalDialogOpen, useShortcutStore } from '@slayzone/ui'

/**
 * Initialize the centralized keyboard shortcut dispatcher.
 * Installs two listeners on window:
 * - Capture phase: modifier shortcuts (Cmd+S, Cmd+G) — beats CM/xterm
 * - Bubble phase: non-modifier shortcuts (Escape) — loses to Radix/popovers
 *
 * Call once from App.tsx. Returns cleanup function.
 */
export function initShortcuts(): () => void {
  scopeTracker.init()

  const shouldSkip = (e: KeyboardEvent): boolean => {
    if (isModalDialogOpen(e)) return true
    if (useShortcutStore.getState().isRecording) return true
    if (scopeTracker.isBrowserPassthrough()) return true
    return false
  }

  const captureHandler = (e: KeyboardEvent) => {
    if (shouldSkip(e)) return
    // Only handle modifier shortcuts in capture phase
    if (!(e.metaKey || e.ctrlKey || e.altKey)) return
    registry.dispatch(e, scopeTracker.getActiveScopes())
  }

  const bubbleHandler = (e: KeyboardEvent) => {
    if (shouldSkip(e)) return
    // Only handle non-modifier shortcuts in bubble phase
    if (e.metaKey || e.ctrlKey || e.altKey) return
    registry.dispatch(e, scopeTracker.getActiveScopes())
  }

  window.addEventListener('keydown', captureHandler, { capture: true })
  window.addEventListener('keydown', bubbleHandler)

  return () => {
    window.removeEventListener('keydown', captureHandler, { capture: true })
    window.removeEventListener('keydown', bubbleHandler)
    scopeTracker.destroy()
  }
}
