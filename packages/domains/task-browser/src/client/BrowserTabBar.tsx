import { Plus } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions
} from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import type { BrowserTabsState } from '../shared'
import { SortableBrowserTab } from './SortableBrowserTab'

interface BrowserTabBarProps {
  tabs: BrowserTabsState
  isPickingElement: boolean
  tabSensors: SensorDescriptor<SensorOptions>[]
  onDragEnd: (event: DragEndEvent) => void
  onSwitch: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, name: string) => void
  onNewTab: () => void
}

export function BrowserTabBar({
  tabs,
  isPickingElement,
  tabSensors,
  onDragEnd,
  onSwitch,
  onClose,
  onRename,
  onNewTab
}: BrowserTabBarProps) {
  return (
    <div className="shrink-0 flex items-center h-10 px-2 gap-1 border-b border-border bg-surface-1 overflow-x-auto scrollbar-hide">
      <DndContext sensors={tabSensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tabs.tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          {tabs.tabs.map((tab) => (
            <SortableBrowserTab
              key={tab.id}
              tab={tab}
              isActive={tab.id === tabs.activeTabId}
              isPickingElement={isPickingElement}
              isLocked={!!tab.locked}
              onSwitch={onSwitch}
              onClose={onClose}
              onRename={onRename}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button
        onClick={onNewTab}
        className="h-7 px-2 rounded-md hover:bg-accent/80 dark:hover:bg-accent/50 text-muted-foreground dark:text-muted-foreground flex items-center"
      >
        <Plus className="size-4" />
      </button>
    </div>
  )
}
