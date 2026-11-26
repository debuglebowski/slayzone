import type { LayoutSlot, PanelInstance, TaskLayout } from '@slayzone/task-contracts'
import { cn } from '@slayzone/ui'
import { PANEL_KINDS, type PanelKind as RenderableKind } from '../panels/registry'
import { PANEL_KIND_COMPONENTS } from '../panels/kinds'

function isRenderable(kind: string): kind is RenderableKind {
  return Object.hasOwn(PANEL_KIND_COMPONENTS, kind)
}

/** One panel instance: its kind's component (a kind this app cannot render shows nothing). */
export function PanelInstanceView({
  instance
}: {
  instance: PanelInstance
}): React.JSX.Element | null {
  if (!isRenderable(instance.kind)) return null
  const Kind = PANEL_KIND_COMPONENTS[instance.kind]
  return <Kind panelId={instance.id} />
}

function tabLabel(instance: PanelInstance): string {
  if (instance.name) return instance.name
  return isRenderable(instance.kind) ? PANEL_KINDS[instance.kind].label : instance.kind
}

interface TabGroupProps {
  layout: TaskLayout
  slot: LayoutSlot
  onActivateTab?: (instanceId: string) => void
}

/**
 * A group of tabs showing its active instance. An unnamed group with one shown tab
 * (every Classic group) renders the bare panel: no strip, no wrapper, so the panel
 * stays a direct item of the strip exactly as before.
 */
export function TabGroup({ layout, slot, onActivateTab }: TabGroupProps): React.JSX.Element | null {
  const tabs = slot.tabs.filter((t) => !t.hidden && layout.instances[t.instanceId])
  const active =
    tabs.find((t) => t.instanceId === slot.activeInstanceId)?.instanceId ?? tabs[0]?.instanceId
  const activeInstance = active ? layout.instances[active] : undefined
  if (!activeInstance) return null
  if (tabs.length === 1 && !slot.name) return <PanelInstanceView instance={activeInstance} />

  return (
    <div data-slot-id={slot.id} className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div role="tablist" className="shrink-0 flex items-center gap-1 pb-1 min-w-0">
        {slot.name && (
          <span className="px-1 text-xs font-medium text-muted-foreground truncate">
            {slot.name}
          </span>
        )}
        {tabs.map((t) => {
          const instance = layout.instances[t.instanceId]
          const selected = t.instanceId === active
          return (
            <button
              key={t.instanceId}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onActivateTab?.(t.instanceId)}
              className={cn(
                'px-2 py-0.5 rounded text-xs truncate',
                selected
                  ? 'bg-tab-active text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              {tabLabel(instance)}
            </button>
          )
        })}
      </div>
      <div className="flex-1 min-h-0 flex [&>[data-panel-id]]:flex-1">
        <PanelInstanceView key={activeInstance.id} instance={activeInstance} />
      </div>
    </div>
  )
}
