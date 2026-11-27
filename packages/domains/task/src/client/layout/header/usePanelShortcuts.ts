import type { PanelInstance } from '@slayzone/task-contracts'
import {
  formatKeysForDisplay,
  resolveShortcutKeys,
  useShortcutStore,
  webPanelShortcutKeys
} from '@slayzone/ui'
import { PANEL_KINDS } from '../../panels/registry'
import { isRenderableKind } from '../panelTabMeta'

/**
 * The display string of the shortcut that toggles a kind's panels (`panel-*`,
 * reactive to user customization), and of a web panel's own letter.
 */
export function usePanelShortcuts(webPanels: readonly { id: string; shortcut?: string }[]): {
  ofKind: (kind: string) => string | null
  ofInstance: (instance: PanelInstance) => string | null
} {
  const overrides = useShortcutStore((s) => s.overrides)
  const ofKind = (kind: string): string | null => {
    if (!isRenderableKind(kind)) return null
    const id = PANEL_KINDS[kind].shortcutId
    return id ? formatKeysForDisplay(resolveShortcutKeys(overrides, id)) : null
  }
  const ofInstance = (instance: PanelInstance): string | null => {
    if (instance.kind !== 'web') return ofKind(instance.kind)
    const webId =
      typeof instance.settings.panelId === 'string' ? instance.settings.panelId : instance.id
    const wp = webPanels.find((p) => p.id === webId)
    return wp ? formatKeysForDisplay(webPanelShortcutKeys(wp.shortcut)) : null
  }
  return { ofKind, ofInstance }
}
