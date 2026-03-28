import { useHotkeys } from 'react-hotkeys-hook'
import type { DependencyList } from 'react'
import type { Keys, HotkeyCallback, Options } from 'react-hotkeys-hook'
import { isModalDialogOpen } from './is-modal-dialog-open'

type OptionsOrDeps = Options | DependencyList

/** Drop-in replacement for useHotkeys that auto-skips when a modal dialog is open. */
export function useGuardedHotkeys<T extends HTMLElement>(
  keys: Keys,
  callback: HotkeyCallback,
  options?: OptionsOrDeps,
  dependencies?: OptionsOrDeps
) {
  // Default enableOnContentEditable so shortcuts work inside editors (CodeMirror, TipTap, Milkdown).
  // Handlers that must defer to the editor (e.g. undo/redo) guard internally via el.isContentEditable.
  const opts = Array.isArray(options) ? options : { enableOnContentEditable: true, ...options }

  return useHotkeys<T>(keys, (e, he) => {
    if (isModalDialogOpen()) return
    callback(e, he)
  }, opts, Array.isArray(options) ? options : dependencies)
}
