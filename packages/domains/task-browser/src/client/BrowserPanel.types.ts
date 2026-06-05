import type { BrowserTab, BrowserTabsState } from '../shared'

export interface TaskUrlEntry {
  taskId: string
  taskTitle: string
  url: string
  tabTitle: string
}

export interface BrowserPanelProps {
  className?: string
  tabs: BrowserTabsState
  onTabsChange: (tabs: BrowserTabsState) => void
  onRequestHide?: () => void
  taskId?: string
  projectId?: string
  isResizing?: boolean
  isActive?: boolean
  onElementSnippet?: (snippet: string) => void
  onScreenshot?: (viewId: string) => void
  canUseDomPicker?: boolean
}

export interface BrowserPanelHandle {
  focus: () => void
  pickElement: () => void
  reload: () => void
  focusUrlBar: () => void
  getActiveViewId: () => string | null
  newTab: (url?: string) => void
}

export interface SortableBrowserTabProps {
  tab: BrowserTab
  isActive: boolean
  isPickingElement: boolean
  isLocked: boolean
  onSwitch: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, name: string) => void
}
