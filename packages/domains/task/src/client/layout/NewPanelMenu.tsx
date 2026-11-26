import { Plus, type LucideIcon } from 'lucide-react'
import type { PanelInstance } from '@slayzone/task-contracts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { PANEL_KINDS, type PanelKind } from '../panels/registry'
import { isRenderableKind } from './panelTabMeta'

/**
 * "New <kind> panel" (docs/plans/panel-model.md step 7): the temporary ways to add
 * another instance of a kind — a tab's or panel toggle's context menu, and the
 * header's New panel list. Step 9 replaces them with the title row's ⋯ menu.
 */
export interface NewPanelChoice {
  /** Unique per choice (a kind, or a web panel's id). */
  key: string
  kind: PanelKind
  label: string
  icon: LucideIcon
  /** Settings of the new instance (a web panel: which one). */
  settings?: Record<string, unknown>
}

/** The legacy enablement id (`panel_config`) of each multi-instance kind. */
const ENABLE_IDS: Partial<Record<PanelKind, string>> = {
  agent: 'terminal',
  terminal: 'terminal',
  browser: 'browser',
  editor: 'editor',
  git: 'diff',
  artifacts: 'artifacts',
  processes: 'processes'
}

/** Every panel a new instance can be added of, in display order. */
export function newPanelChoices(
  webPanels: readonly { id: string; name: string }[],
  isEnabled: (legacyId: string) => boolean
): NewPanelChoice[] {
  const out: NewPanelChoice[] = []
  for (const [kind, enableId] of Object.entries(ENABLE_IDS) as [PanelKind, string][]) {
    const def = PANEL_KINDS[kind]
    if (!def.multiInstance || !isEnabled(enableId)) continue
    out.push({ key: kind, kind, label: def.label, icon: def.icon })
  }
  for (const wp of webPanels)
    out.push({
      key: wp.id,
      kind: 'web',
      label: wp.name,
      icon: PANEL_KINDS.web.icon,
      settings: { panelId: wp.id }
    })
  return out
}

/** The choice that adds another panel like `instance` (null: its kind stays single). */
export function newPanelChoiceLike(
  instance: PanelInstance,
  webPanels: readonly { id: string; name: string }[]
): NewPanelChoice | null {
  if (!isRenderableKind(instance.kind) || !PANEL_KINDS[instance.kind].multiInstance) return null
  const def = PANEL_KINDS[instance.kind]
  if (instance.kind !== 'web')
    return { key: def.kind, kind: def.kind, label: def.label, icon: def.icon }
  const webId =
    typeof instance.settings.panelId === 'string' ? instance.settings.panelId : instance.id
  const wp = webPanels.find((p) => p.id === webId)
  return wp
    ? { key: wp.id, kind: 'web', label: wp.name, icon: def.icon, settings: { panelId: wp.id } }
    : null
}

/** The choice a legacy panel toggle id (`terminal`, `diff`, `web:*` …) stands for. */
export function newPanelChoiceForToggle(
  toggleId: string,
  webPanels: readonly { id: string; name: string }[]
): NewPanelChoice | null {
  const kind: PanelKind | null =
    toggleId === 'terminal'
      ? 'agent'
      : toggleId === 'diff'
        ? 'git'
        : toggleId.startsWith('web:')
          ? 'web'
          : isRenderableKind(toggleId)
            ? toggleId
            : null
  if (!kind) return null
  return newPanelChoiceLike(
    {
      id: toggleId,
      kind,
      settings: kind === 'web' ? { panelId: toggleId } : {}
    },
    webPanels
  )
}

/** The header's New panel list: a "+" opening every panel a new instance can be added of. */
export function NewPanelMenu({
  choices,
  onAdd,
  align = 'end'
}: {
  choices: readonly NewPanelChoice[]
  onAdd: (choice: NewPanelChoice) => void
  align?: 'start' | 'end'
}): React.JSX.Element | null {
  if (choices.length === 0) return null
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="New panel"
              data-testid="new-panel-menu"
              className="shrink-0 inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <Plus className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">New panel</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align={align} className="min-w-[180px]">
        <DropdownMenuLabel>New panel</DropdownMenuLabel>
        {choices.map((c) => (
          <DropdownMenuItem key={c.key} className="gap-2" onSelect={() => onAdd(c)}>
            <c.icon className="size-4" />
            {c.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
