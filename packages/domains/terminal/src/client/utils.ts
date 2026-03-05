import type { TerminalModeInfo } from '../shared/types'

/**
 * Filter and sort AI terminal modes for display in selectors.
 * Returns only database-driven AI modes. "Terminal" is handled manually by components
 * to allow for custom placement (e.g. at the bottom with a separator).
 */
export function getVisibleModes(modes: TerminalModeInfo[], currentMode?: string | null): TerminalModeInfo[] {
  const filtered = modes.filter(m => m.enabled || m.id === currentMode)
  return [...filtered].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/**
 * Groups terminal modes into Built-in and Custom categories.
 */
export function groupTerminalModes(modes: TerminalModeInfo[]) {
  const builtin = modes.filter(m => m.isBuiltin && m.id !== 'terminal')
  const custom = modes.filter(m => !m.isBuiltin)
  
  return { builtin, custom }
}

/**
 * Get the display label for a terminal mode, with special handling for built-in cases.
 */
export function getModeLabel(mode: TerminalModeInfo | { id: string; label: string }): string {
  if (mode.id === 'terminal') return 'Terminal'
  return mode.label
}
