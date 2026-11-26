import type { LayoutSlot, PanelInstance, TaskLayout } from '@slayzone/task-contracts'
import { PANEL_KIND_COMPONENTS } from '../panels/kinds'
import { PanelCellContext } from '../panels/PanelFrame'
import { TaskPageProvider, useTaskPageContext } from '../panels/TaskPageContext'
import { isRenderableKind } from './panelTabMeta'
import { TabStrip } from './TabStrip'

/** One panel instance: its kind's component (a kind this app cannot render shows nothing). */
export function PanelInstanceView({
  instance
}: {
  instance: PanelInstance
}): React.JSX.Element | null {
  if (!isRenderableKind(instance.kind)) return null
  const Kind = PANEL_KIND_COMPONENTS[instance.kind]
  return <Kind panelId={instance.id} />
}

/**
 * A tab's panel. Every shown tab of a group stays mounted; the inactive ones are
 * out of view (display: none) and see their task page as inactive — the same
 * keep-alive a task tab in the background gets (PANEL_KINDS[kind].keepAlive):
 * browser, web and the agent stay mounted and park themselves (`isActive` false:
 * native views off-screen, terminal paused); every other kind goes into
 * <Activity hidden> in its PanelFrame. The wrapper never changes element type,
 * so switching tabs moves no DOM.
 */
function TabPanel({
  instance,
  active
}: {
  instance: PanelInstance
  active: boolean
}): React.JSX.Element {
  const page = useTaskPageContext()
  const value = active ? page : { ...page, isActive: false, shortcutActive: false }
  return (
    <div className={active ? 'contents' : 'hidden'} data-tab-panel={instance.id}>
      <TaskPageProvider value={value}>
        <PanelInstanceView instance={instance} />
      </TaskPageProvider>
    </div>
  )
}

interface TabGroupProps {
  layout: TaskLayout
  slot: LayoutSlot
  /** No strip and no drag (the explode-mode cell). */
  compact?: boolean
}

/**
 * A group of tabs showing its active instance. An unnamed group with one shown tab
 * (every Classic group) renders the bare panel: no strip, no wrapper, so the panel
 * stays a direct item of the strip exactly as before. Otherwise the TabStrip sits
 * on top and each tab's panel fills the cell below it.
 */
export function TabGroup({
  layout,
  slot,
  compact = false
}: TabGroupProps): React.JSX.Element | null {
  const tabs = slot.tabs.filter((t) => !t.hidden && layout.instances[t.instanceId])
  const active =
    tabs.find((t) => t.instanceId === slot.activeInstanceId)?.instanceId ?? tabs[0]?.instanceId
  const activeInstance = active ? layout.instances[active] : undefined
  if (!active || !activeInstance) return null
  if (compact || (tabs.length === 1 && !slot.name))
    return <PanelInstanceView instance={activeInstance} />

  return (
    <div data-slot-id={slot.id} className="flex-1 min-h-0 min-w-0 flex flex-col">
      <TabStrip layout={layout} slot={slot} tabs={tabs} activeId={active} />
      <div className="flex-1 min-h-0 min-w-0 flex">
        <PanelCellContext value={true}>
          {tabs.map((t) => (
            <TabPanel
              key={t.instanceId}
              instance={layout.instances[t.instanceId]}
              active={t.instanceId === active}
            />
          ))}
        </PanelCellContext>
      </div>
    </div>
  )
}
