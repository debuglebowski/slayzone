import type { PanelConfig, WebPanelDefinition } from './types'
import { PREDEFINED_WEB_PANELS, DEFAULT_PANEL_ORDER, PANEL_ORDER_IDS } from './types'
import { inferHostScopeFromUrl, inferProtocolFromUrl } from './handoff'

/** Ensure config.order exists and contains every current panel ID (natives + web).
 *  Missing IDs are appended in their default position; removed web panels are pruned. */
export function mergePanelOrder(config: PanelConfig): PanelConfig {
  const validIds = new Set<string>([...PANEL_ORDER_IDS, ...config.webPanels.map(wp => wp.id)])
  const prev = config.order ?? []
  const filtered = prev.filter(id => validIds.has(id))
  const present = new Set(filtered)
  const missing: string[] = []
  for (const id of DEFAULT_PANEL_ORDER) if (validIds.has(id) && !present.has(id)) missing.push(id)
  for (const wp of config.webPanels) if (!present.has(wp.id) && !DEFAULT_PANEL_ORDER.includes(wp.id)) missing.push(wp.id)
  const next = [...filtered, ...missing]
  const changed = !config.order || next.length !== prev.length || next.some((id, i) => id !== prev[i])
  return changed ? { ...config, order: next } : config
}

/** Merge predefined panels into stored config (adds missing, syncs defaults, skips user-deleted). */
export function mergePredefinedWebPanels(config: PanelConfig): PanelConfig {
  const existingIds = new Set(config.webPanels.map((wp) => wp.id))
  const deleted = new Set(config.deletedPredefined ?? [])
  const missing = PREDEFINED_WEB_PANELS.filter((panel) => !existingIds.has(panel.id) && !deleted.has(panel.id))
  const predefinedMap = new Map(PREDEFINED_WEB_PANELS.map((panel) => [panel.id, panel]))

  const synced = config.webPanels.map((panel) => {
    const predefined = predefinedMap.get(panel.id)
    const withShortcut =
      predefined && panel.shortcut !== predefined.shortcut ? { ...panel, shortcut: predefined.shortcut } : panel

    let migrated = withShortcut
    if (migrated.blockDesktopHandoff === undefined && predefined?.blockDesktopHandoff !== undefined) {
      migrated = { ...migrated, blockDesktopHandoff: predefined.blockDesktopHandoff }
    }

    if (migrated.handoffProtocol === undefined && predefined?.handoffProtocol !== undefined) {
      migrated = { ...migrated, handoffProtocol: predefined.handoffProtocol }
    } else if (migrated.handoffProtocol === undefined && migrated.blockDesktopHandoff === true) {
      const inferredProtocol = inferProtocolFromUrl(migrated.baseUrl)
      if (inferredProtocol) migrated = { ...migrated, handoffProtocol: inferredProtocol }
    }

    if (migrated.handoffHostScope === undefined && migrated.blockDesktopHandoff === true) {
      const inferredHostScope = inferHostScopeFromUrl(migrated.baseUrl)
      if (inferredHostScope) migrated = { ...migrated, handoffHostScope: inferredHostScope }
      else if (predefined?.handoffHostScope !== undefined) migrated = { ...migrated, handoffHostScope: predefined.handoffHostScope }
    }

    return migrated
  })

  const changed = missing.length > 0 || synced.some((panel, i) => panel !== config.webPanels[i])
  if (!changed) return config

  return { ...config, webPanels: [...synced, ...missing] }
}

const RESERVED_PANEL_SHORTCUTS = new Set(['k', 'b', 'e', 'g', 's'])

/** Validate a panel keyboard shortcut. Returns null if valid, or an error message if invalid. */
export function validatePanelShortcut(
  letter: string,
  existingPanels: WebPanelDefinition[],
  excludeId?: string
): string | null {
  if (!letter) return null
  const l = letter.toLowerCase()
  if (l.length !== 1 || !/^[a-z]$/.test(l)) return 'Must be a single letter'
  if (RESERVED_PANEL_SHORTCUTS.has(l)) return `Cmd+${l.toUpperCase()} is reserved for a built-in panel`
  const existing = existingPanels.find(wp => wp.shortcut === l && wp.id !== excludeId)
  if (existing) return `Cmd+${l.toUpperCase()} is already used by ${existing.name}`
  return null
}
