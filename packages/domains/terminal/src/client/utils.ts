import type { TerminalModeInfo } from '../shared/types'

/**
 * Filter and sort terminal modes for display in selectors.
 */
export function getVisibleModes(modes: TerminalModeInfo[], currentMode?: string | null): TerminalModeInfo[] {
  const filtered = modes.filter(m => m.enabled || m.id === currentMode)
  return [...filtered].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/**
 * Groups terminal modes into Built-in and Custom categories.
 */
export function groupTerminalModes(modes: TerminalModeInfo[]) {
  const builtin = modes.filter(m => m.isBuiltin)
  const custom = modes.filter(m => !m.isBuiltin)
  
  return { builtin, custom }
}

/**
 * Get the display label for a terminal mode, with special handling for built-in cases.
 */
export function getModeLabel(mode: TerminalModeInfo | { id: string; label: string }): string {
  return mode.label
}
