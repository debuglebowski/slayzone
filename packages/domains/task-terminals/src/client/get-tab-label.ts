import type { TerminalTab } from '../shared/types'

/**
 * Resolve display label for a terminal tab.
 * Priority: user-set label > mode name (main only) > process title > "Terminal"
 */
export function getTabLabel(tab: TerminalTab, processTitle?: string): string {
  if (tab.label) return tab.label
  if (tab.isMain) {
    switch (tab.mode) {
      case 'claude-code': return 'Claude Code'
      case 'codex': return 'Codex'
      case 'cursor-agent': return 'Cursor'
      case 'gemini': return 'Gemini'
      case 'opencode': return 'OpenCode'
      case 'ccs': return 'CCS'
      default: return 'Terminal'
    }
  }
  if (processTitle) return processTitle
  return 'Terminal'
}

/**
 * Append "(2)", "(3)" etc. to duplicate labels so tabs are distinguishable.
 * First occurrence keeps the bare label; subsequent get numbered.
 */
export function numberDuplicateLabels(labels: Map<string, string>): Map<string, string> {
  const counts = new Map<string, number>()
  for (const label of labels.values()) {
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const result = new Map<string, string>()
  for (const [id, label] of labels) {
    const total = counts.get(label)!
    if (total === 1) {
      result.set(id, label)
    } else {
      const n = (seen.get(label) ?? 0) + 1
      seen.set(label, n)
      result.set(id, n === 1 ? label : `${label} (${n})`)
    }
  }
  return result
}
