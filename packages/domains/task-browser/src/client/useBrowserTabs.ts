import { useCallback } from 'react'
import { track } from '@slayzone/telemetry/client'
import { useSensor, useSensors, PointerSensor, type DragEndEvent } from '@dnd-kit/core'
import type { BrowserTab, BrowserTabsState } from '../shared'
import { generateTabId } from './BrowserPanel.utils'

interface UseBrowserTabsParams {
  tabs: BrowserTabsState
  onTabsChange: (tabs: BrowserTabsState) => void
  onRequestHide?: () => void
  browserDefaultUrl: string
}

export function useBrowserTabs({
  tabs,
  onTabsChange,
  onRequestHide,
  browserDefaultUrl
}: UseBrowserTabsParams) {
  // Tab callbacks
  const newTabUrl = browserDefaultUrl || 'about:blank'
  const createNewTab = useCallback(
    (url?: string) => {
      const tabUrl = url ?? newTabUrl
      const newTab: BrowserTab = {
        id: generateTabId(),
        url: tabUrl,
        title: tabUrl === 'about:blank' ? 'New Tab' : tabUrl
      }
      onTabsChange({
        tabs: [...tabs.tabs, newTab],
        activeTabId: newTab.id
      })
      track('web_panel_tab_added', { predefined_vs_custom: 'custom' })
    },
    [tabs, onTabsChange, newTabUrl]
  )

  const closeTab = useCallback(
    (tabId: string) => {
      const idx = tabs.tabs.findIndex((t) => t.id === tabId)
      const newTabs = tabs.tabs.filter((t) => t.id !== tabId)

      let newActiveId = tabs.activeTabId
      if (tabId === tabs.activeTabId) {
        if (newTabs.length === 0) {
          onTabsChange({ tabs: [], activeTabId: null })
          track('browser_tab_closed')
          onRequestHide?.()
          return
        }
        newActiveId = newTabs[Math.min(idx, newTabs.length - 1)]?.id || null
      }

      onTabsChange({ tabs: newTabs, activeTabId: newActiveId })
      track('browser_tab_closed')
    },
    [tabs, onTabsChange, onRequestHide]
  )

  const switchToTab = useCallback(
    (tabId: string) => {
      onTabsChange({ ...tabs, activeTabId: tabId })
    },
    [tabs, onTabsChange]
  )

  const renameTab = useCallback(
    (tabId: string, name: string) => {
      const next = tabs.tabs.map((t) =>
        t.id === tabId ? { ...t, customName: name || undefined } : t
      )
      onTabsChange({ ...tabs, tabs: next })
    },
    [tabs, onTabsChange]
  )

  const reorderTabs = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return
      const fromIdx = tabs.tabs.findIndex((t) => t.id === fromId)
      const toIdx = tabs.tabs.findIndex((t) => t.id === toId)
      if (fromIdx === -1 || toIdx === -1) return
      const next = [...tabs.tabs]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      onTabsChange({ ...tabs, tabs: next })
      track('web_panel_tab_reordered')
    },
    [tabs, onTabsChange]
  )

  const tabSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }))

  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over) return
      reorderTabs(active.id as string, over.id as string)
    },
    [reorderTabs]
  )

  const switchToNextTab = useCallback(() => {
    const idx = tabs.tabs.findIndex((t) => t.id === tabs.activeTabId)
    switchToTab(tabs.tabs[(idx + 1) % tabs.tabs.length].id)
  }, [tabs, switchToTab])

  const switchToPrevTab = useCallback(() => {
    const idx = tabs.tabs.findIndex((t) => t.id === tabs.activeTabId)
    switchToTab(tabs.tabs[(idx - 1 + tabs.tabs.length) % tabs.tabs.length].id)
  }, [tabs, switchToTab])

  return {
    newTabUrl,
    createNewTab,
    closeTab,
    switchToTab,
    renameTab,
    reorderTabs,
    tabSensors,
    handleTabDragEnd,
    switchToNextTab,
    switchToPrevTab
  }
}
