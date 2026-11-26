import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import type { PanelInstance } from '@slayzone/task-contracts'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { PANEL_KINDS, type PanelKind } from '../../panels/registry'
import { isRenderableKind, panelEnableId } from '../panelTabMeta'
import { HEADER_BUTTON_CLASS } from './headerButton'

/**
 * The title row's ⋯ "New panel" menu (docs/plans/panel-model.md step 9): every
 * panel a new instance can be added of, with its icon and shortcut. A tab's
 * right-click "New <kind> panel" adds one next to it.
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

/** Menu sections, in display order, and the kinds each holds. */
const SECTIONS: readonly { label: string; kinds: readonly PanelKind[] }[] = [
  { label: 'Run', kinds: ['agent', 'terminal', 'processes'] },
  { label: 'Code', kinds: ['editor', 'git'] },
  { label: 'Content', kinds: ['browser', 'web', 'artifacts'] }
]

/** Kinds the menu offers (besides web panels), in order. */
const KINDS: readonly PanelKind[] = [
  'agent',
  'terminal',
  'browser',
  'editor',
  'git',
  'artifacts',
  'processes'
]

/** Every panel a new instance can be added of, in display order. */
export function newPanelChoices(
  webPanels: readonly { id: string; name: string }[],
  isEnabled: (legacyId: string) => boolean
): NewPanelChoice[] {
  const out: NewPanelChoice[] = []
  for (const kind of KINDS) {
    const def = PANEL_KINDS[kind]
    const enableId = panelEnableId(kind)
    if (!def.multiInstance || !enableId || !isEnabled(enableId)) continue
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

/** Choices grouped into the menu's sections (empty sections dropped). */
export function newPanelSections(
  choices: readonly NewPanelChoice[]
): { label: string; choices: NewPanelChoice[] }[] {
  return SECTIONS.map((s) => ({
    label: s.label,
    choices: choices.filter((c) => s.kinds.includes(c.kind))
  })).filter((s) => s.choices.length > 0)
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

/** ⋯ after the group toggles: opens the New panel menu. */
export function NewPanelMenu({
  choices,
  onAdd,
  shortcutOf,
  align = 'end'
}: {
  choices: readonly NewPanelChoice[]
  onAdd: (choice: NewPanelChoice) => void
  /** The shortcut shown beside a choice (the kind's or the web panel's). */
  shortcutOf: (choice: NewPanelChoice) => string | null
  align?: 'start' | 'end'
}): React.JSX.Element | null {
  if (choices.length === 0) return null
  const sections = newPanelSections(choices)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="New panel"
              data-testid="new-panel-menu"
              className={HEADER_BUTTON_CLASS}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">New panel</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align={align}
        data-testid="new-panel-menu-content"
        className="w-max min-w-48 max-w-80"
      >
        {sections.map((section, i) => (
          <div key={section.label} role="group" aria-label={section.label}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {section.label}
            </DropdownMenuLabel>
            {section.choices.map((c) => {
              const shortcut = shortcutOf(c)
              return (
                <DropdownMenuItem key={c.key} className="gap-2.5" onSelect={() => onAdd(c)}>
                  <c.icon className={cn('size-4', PANEL_KINDS[c.kind].iconClassName)} />
                  <span className="flex-1 truncate">{c.label}</span>
                  {shortcut && (
                    <span className="ml-4 text-[10px] text-muted-foreground tabular-nums">
                      {shortcut}
                    </span>
                  )}
                </DropdownMenuItem>
              )
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
