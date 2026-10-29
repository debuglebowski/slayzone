import { useEffect, type RefObject } from 'react'
import { useStableCallback } from '@slayzone/ui'

/**
 * Handles one keydown for the prompt dock; true when the key was consumed. The
 * chat panel's keyboard hook calls it before its own shortcuts, so the TUI's
 * prompt keys (1/2/3, ↑/↓, Enter, Esc, Tab) work wherever focus is in the
 * panel — except in a text field, where typing wins (Esc still answers).
 */
export type PromptKeyHandler = (e: KeyboardEvent) => boolean

/** A text field has focus: plain keys type, they don't pick rows. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return (
    el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'button')
  )
}

/** A plain key (no modifier) — what the TUI's row keys are. */
export function isPlainKey(e: KeyboardEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey
}

/** Register the active prompt body's key handler with the dock's ref. */
export function usePromptKeys(
  keysRef: RefObject<PromptKeyHandler | null> | undefined,
  handler: PromptKeyHandler
): void {
  const stable = useStableCallback(handler)
  useEffect(() => {
    if (!keysRef) return
    keysRef.current = stable
    return () => {
      if (keysRef.current === stable) keysRef.current = null
    }
  }, [keysRef, stable])
}
