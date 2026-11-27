import { Link, Square, type LucideIcon } from 'lucide-react'
import type { PanelInstance } from '@slayzone/task-contracts'
import {
  artifactIdOf,
  isWebPageInstance,
  webPageLabel,
  webPageUrlOf
} from '@slayzone/task-contracts'
import { PANEL_KINDS, type PanelKind as RenderableKind } from '../panels/registry'

/** A kind this app has a component for (a newer app's kind renders nothing here). */
export function isRenderableKind(kind: string): kind is RenderableKind {
  return Object.hasOwn(PANEL_KINDS, kind)
}

/**
 * The `panel_config` id that enables a kind in the task view (`isBuiltinEnabled`);
 * web panels are enabled one by one, so they have none. Settings' cards on their
 * own follow Settings; an Artifact panel follows Artifacts.
 */
const ENABLE_IDS: Partial<Record<RenderableKind, string>> = {
  agent: 'terminal',
  terminal: 'terminal',
  browser: 'browser',
  editor: 'editor',
  git: 'diff',
  artifacts: 'artifacts',
  artifact: 'artifacts',
  processes: 'processes',
  settings: 'settings',
  description: 'settings',
  subtasks: 'settings',
  details: 'settings'
}

export function panelEnableId(kind: string): string | null {
  return isRenderableKind(kind) ? (ENABLE_IDS[kind] ?? null) : null
}

/** Kinds that show the task's own fields (Settings and its cards): none on a temporary task. */
export const TASK_FIELD_KINDS: ReadonlySet<string> = new Set([
  'settings',
  'description',
  'subtasks',
  'details'
])

/** What a panel tab may name besides the instance: the task's web panels and artifacts. */
export interface PanelTabNames {
  webPanels: readonly { id: string; name: string }[]
  artifacts?: readonly { id: string; title: string }[]
}

/**
 * A panel tab's label and icon: the instance's own name, else what it shows (a web
 * panel's configured name, a web page's host, an artifact's title), else its kind's
 * label.
 */
export function panelTabMeta(
  instance: PanelInstance,
  webPanels: PanelTabNames['webPanels'],
  artifacts: PanelTabNames['artifacts'] = []
): { label: string; icon: LucideIcon } {
  const def = isRenderableKind(instance.kind) ? PANEL_KINDS[instance.kind] : null
  if (isWebPageInstance(instance)) {
    const url = webPageUrlOf(instance)
    return { label: instance.name ?? (url ? webPageLabel(url) : 'Web page'), icon: Link }
  }
  const webId =
    typeof instance.settings.panelId === 'string' ? instance.settings.panelId : instance.id
  const webName =
    instance.kind === 'web' ? webPanels.find((wp) => wp.id === webId)?.name : undefined
  const artifactId = artifactIdOf(instance)
  const artifactName = artifactId ? artifacts.find((a) => a.id === artifactId)?.title : undefined
  return {
    label: instance.name ?? webName ?? artifactName ?? def?.label ?? instance.kind,
    icon: def?.icon ?? Square
  }
}
