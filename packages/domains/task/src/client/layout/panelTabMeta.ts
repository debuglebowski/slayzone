import { Square, type LucideIcon } from 'lucide-react'
import type { PanelInstance } from '@slayzone/task-contracts'
import { PANEL_KINDS, type PanelKind as RenderableKind } from '../panels/registry'

/** A kind this app has a component for (a newer app's kind renders nothing here). */
export function isRenderableKind(kind: string): kind is RenderableKind {
  return Object.hasOwn(PANEL_KINDS, kind)
}

/**
 * The `panel_config` id that enables a kind in the task view (`isBuiltinEnabled`);
 * web panels are enabled one by one, so they have none.
 */
const ENABLE_IDS: Partial<Record<RenderableKind, string>> = {
  agent: 'terminal',
  terminal: 'terminal',
  browser: 'browser',
  editor: 'editor',
  git: 'diff',
  artifacts: 'artifacts',
  processes: 'processes',
  settings: 'settings'
}

export function panelEnableId(kind: string): string | null {
  return isRenderableKind(kind) ? (ENABLE_IDS[kind] ?? null) : null
}

/**
 * A panel tab's label and icon: the instance's own name, else a web panel's
 * configured name, else its kind's label.
 */
export function panelTabMeta(
  instance: PanelInstance,
  webPanels: readonly { id: string; name: string }[]
): { label: string; icon: LucideIcon } {
  const def = isRenderableKind(instance.kind) ? PANEL_KINDS[instance.kind] : null
  const webId =
    typeof instance.settings.panelId === 'string' ? instance.settings.panelId : instance.id
  const webName =
    instance.kind === 'web' ? webPanels.find((wp) => wp.id === webId)?.name : undefined
  return {
    label: instance.name ?? webName ?? def?.label ?? instance.kind,
    icon: def?.icon ?? Square
  }
}
