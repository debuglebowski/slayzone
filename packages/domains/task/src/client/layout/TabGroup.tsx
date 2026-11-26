import type { LayoutSlot, TaskLayout } from '@slayzone/task-contracts'
import { PanelTarget } from './PanelHosts'
import { TabStrip } from './TabStrip'
import { renderedTabs, shownTabOf, showsTabStrip } from './strip'

interface TabGroupProps {
  layout: TaskLayout
  slot: LayoutSlot
  /** No strip and no drag (the explode-mode cell). */
  compact?: boolean
}

/**
 * A group of tabs showing its active instance. An unnamed group with one shown tab
 * (every Classic group) renders the bare panel: no strip, no box of its own, so the
 * panel stays a direct item of the strip exactly as before. Otherwise the TabStrip
 * sits on top and each tab's panel fills the cell below it: every shown tab stays
 * mounted, the inactive ones out of view (display: none). The wrapper never changes
 * element type, so switching tabs moves no DOM.
 *
 * Panels render where their `PanelTarget` is (see PanelHosts): this tree only says
 * where each one goes.
 */
export function TabGroup({
  layout,
  slot,
  compact = false
}: TabGroupProps): React.JSX.Element | null {
  const active = shownTabOf(layout, slot)
  if (!active) return null
  if (compact || !showsTabStrip(slot)) return <PanelTarget instanceId={active} />
  const tabs = renderedTabs(layout, slot)

  return (
    <div data-slot-id={slot.id} className="flex-1 min-h-0 min-w-0 flex flex-col">
      <TabStrip layout={layout} slot={slot} tabs={tabs} activeId={active} />
      <div className="flex-1 min-h-0 min-w-0 flex">
        {tabs.map((t) => (
          <div
            key={t.instanceId}
            className={t.instanceId === active ? 'contents' : 'hidden'}
            data-tab-panel={t.instanceId}
          >
            <PanelTarget instanceId={t.instanceId} />
          </div>
        ))}
      </div>
    </div>
  )
}
