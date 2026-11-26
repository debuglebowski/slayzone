import { Link, MoreHorizontal, type LucideIcon } from 'lucide-react'
import type { PanelInstance } from '@slayzone/task-contracts'
import { isWebPageInstance, webPageSettings } from '@slayzone/task-contracts'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  /** Settings of the new instance (a web panel: which one; an artifact: which file). */
  settings?: Record<string, unknown>
  /** A submenu instead (Artifact ▸ the task's files); the choice itself adds nothing. */
  children?: NewPanelChoice[]
}

/** Menu sections, in display order, and the kinds each holds. */
const SECTIONS: readonly { label: string; kinds: readonly PanelKind[] }[] = [
  { label: 'Run', kinds: ['agent', 'terminal', 'processes'] },
  { label: 'Code', kinds: ['editor', 'git'] },
  { label: 'Content', kinds: ['browser', 'web', 'artifacts', 'artifact'] },
  { label: 'Task', kinds: ['description', 'subtasks', 'details'] }
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

/** Settings' cards on their own (one each per task: adding one the task has shows it). */
const TASK_KINDS: readonly PanelKind[] = ['description', 'subtasks', 'details']

/** A new Web page (asks for its URL when it first shows). */
const WEB_PAGE_CHOICE: NewPanelChoice = {
  key: 'web-page',
  kind: 'web',
  label: 'Web page',
  icon: Link,
  settings: webPageSettings()
}

/**
 * Every panel a new instance can be added of, in display order: the kinds, a Web
 * page, each configured web panel (a web page preset), Artifact ▸ one per task
 * file, and Settings' cards on their own.
 */
export function newPanelChoices(
  webPanels: readonly { id: string; name: string }[],
  isEnabled: (legacyId: string) => boolean,
  artifacts: readonly { id: string; title: string }[] = []
): NewPanelChoice[] {
  const enabled = (kind: PanelKind): boolean => {
    const enableId = panelEnableId(kind)
    return !!enableId && isEnabled(enableId)
  }
  const out: NewPanelChoice[] = []
  for (const kind of KINDS) {
    const def = PANEL_KINDS[kind]
    if (!def.multiInstance || !enabled(kind)) continue
    out.push({ key: kind, kind, label: def.label, icon: def.icon })
  }
  out.push(WEB_PAGE_CHOICE)
  for (const wp of webPanels)
    out.push({
      key: wp.id,
      kind: 'web',
      label: wp.name,
      icon: PANEL_KINDS.web.icon,
      settings: { panelId: wp.id }
    })
  if (enabled('artifact') && artifacts.length > 0) {
    const def = PANEL_KINDS.artifact
    out.push({
      key: 'artifact',
      kind: 'artifact',
      label: def.label,
      icon: def.icon,
      children: artifacts.map((a) => ({
        key: `artifact:${a.id}`,
        kind: 'artifact',
        label: a.title,
        icon: def.icon,
        settings: { artifactId: a.id }
      }))
    })
  }
  for (const kind of TASK_KINDS) {
    if (!enabled(kind)) continue
    const def = PANEL_KINDS[kind]
    out.push({ key: kind, kind, label: def.label, icon: def.icon })
  }
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
  // An Artifact panel is about one file: another needs a file (⋯ → Artifact).
  if (instance.kind === 'artifact') return null
  if (isWebPageInstance(instance)) return WEB_PAGE_CHOICE
  if (instance.kind !== 'web')
    return { key: def.kind, kind: def.kind, label: def.label, icon: def.icon }
  const webId =
    typeof instance.settings.panelId === 'string' ? instance.settings.panelId : instance.id
  const wp = webPanels.find((p) => p.id === webId)
  return wp
    ? { key: wp.id, kind: 'web', label: wp.name, icon: def.icon, settings: { panelId: wp.id } }
    : null
}

/** A panel a layout switch parked (it kept live state the new layout had no place for). */
export interface ParkedPanel {
  instanceId: string
  label: string
  icon: LucideIcon
  iconClassName: string
}

/** ⋯ after the group toggles: opens the New panel menu (and lists parked panels). */
export function NewPanelMenu({
  choices,
  onAdd,
  shortcutOf,
  parked = [],
  onUnpark,
  align = 'end'
}: {
  choices: readonly NewPanelChoice[]
  onAdd: (choice: NewPanelChoice) => void
  /** The shortcut shown beside a choice (the kind's or the web panel's). */
  shortcutOf: (choice: NewPanelChoice) => string | null
  /** Panels a layout switch parked: "Parked", each brought back by a click. */
  parked?: readonly ParkedPanel[]
  onUnpark?: (instanceId: string) => void
  align?: 'start' | 'end'
}): React.JSX.Element | null {
  if (choices.length === 0 && parked.length === 0) return null
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
              if (c.children)
                return (
                  <DropdownMenuSub key={c.key}>
                    <DropdownMenuSubTrigger className="gap-2.5" data-testid={`new-panel-${c.key}`}>
                      <c.icon className={cn('size-4', PANEL_KINDS[c.kind].iconClassName)} />
                      <span className="flex-1 truncate">{c.label}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-max min-w-48 max-w-80 max-h-80 overflow-y-auto">
                      {c.children.map((child) => (
                        <DropdownMenuItem
                          key={child.key}
                          className="gap-2.5"
                          data-testid={`new-panel-${child.key}`}
                          onSelect={() => onAdd(child)}
                        >
                          <child.icon
                            className={cn('size-4', PANEL_KINDS[child.kind].iconClassName)}
                          />
                          <span className="flex-1 truncate">{child.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )
              const shortcut = shortcutOf(c)
              return (
                <DropdownMenuItem
                  key={c.key}
                  className="gap-2.5"
                  data-testid={`new-panel-${c.key}`}
                  onSelect={() => onAdd(c)}
                >
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
        {parked.length > 0 && (
          <div role="group" aria-label="Parked" data-testid="parked-panels">
            {sections.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">Parked</DropdownMenuLabel>
            {parked.map((p) => (
              <DropdownMenuItem
                key={p.instanceId}
                className="gap-2.5"
                data-testid={`parked-panel-${p.instanceId}`}
                onSelect={() => onUnpark?.(p.instanceId)}
              >
                <p.icon className={cn('size-4', p.iconClassName)} />
                <span className="flex-1 truncate">{p.label}</span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
