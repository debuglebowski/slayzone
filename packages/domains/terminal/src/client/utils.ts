import type { AgentDefinition } from '@slayzone/terminal-contracts'

/**
 * Filter and sort agents for display in selectors.
 */
export function getVisibleModes(
  modes: AgentDefinition[],
  currentMode?: string | null
): AgentDefinition[] {
  const filtered = modes.filter((m) => m.enabled || m.id === currentMode)
  return [...filtered].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/**
 * Groups agents into Built-in and Custom categories.
 */
export function groupAgents(modes: AgentDefinition[]) {
  const builtin = modes.filter((m) => m.isBuiltin)
  const custom = modes.filter((m) => !m.isBuiltin)

  return { builtin, custom }
}

/**
 * Get the display label for an agent, with special handling for built-in cases.
 */
export function getModeLabel(mode: AgentDefinition | { id: string; label: string }): string {
  return mode.label
}
