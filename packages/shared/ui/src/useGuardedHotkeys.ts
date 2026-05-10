import { useHotkeys } from 'react-hotkeys-hook'
import type { DependencyList } from 'react'
import type { Keys, HotkeyCallback, Options } from 'react-hotkeys-hook'
import { detectPlatform } from '@slayzone/shortcuts'
import { isModalDialogOpen } from './is-modal-dialog-open'

type OptionsOrDeps = Options | DependencyList

// react-hotkeys-hook v5 treats `mod` as `meta OR ctrl` — fires on Ctrl+. AND Cmd+.
// Resolve to platform-specific modifier so binding is exclusive.
function resolveMod(keys: Keys | null | undefined): Keys {
  const target = detectPlatform() === 'mac' ? 'meta' : 'ctrl'
  const swap = (s: string) => s.split(',').map(part => part.split('+').map(p => p.trim() === 'mod' ? target : p).join('+')).join(',')
  if (keys == null) return ''
  return Array.isArray(keys) ? keys.map(swap) : swap(keys as string)
}

/** Drop-in replacement for useHotkeys that auto-skips when a modal dialog is open. */
export function useGuardedHotkeys<T extends HTMLElement>(
  keys: Keys,
  callback: HotkeyCallback,
  options?: OptionsOrDeps,
  dependencies?: OptionsOrDeps
) {
  // Default enableOnContentEditable so shortcuts work inside editors (CodeMirror, Milkdown).
  // Handlers that must defer to the editor (e.g. undo/redo) guard internally via el.isContentEditable.
  const opts = Array.isArray(options) ? options : { enableOnContentEditable: true, ...options }

  return useHotkeys<T>(resolveMod(keys), (e, he) => {
    if (isModalDialogOpen()) return
    callback(e, he)
  }, opts, Array.isArray(options) ? options : dependencies)
}
