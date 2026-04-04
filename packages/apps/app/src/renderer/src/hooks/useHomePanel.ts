import { useState, useCallback, useRef, useMemo } from 'react'
import type { UnifiedGitPanelHandle, GitTabId } from '@slayzone/worktrees'
import type { FileEditorViewHandle } from '@slayzone/file-editor/client'
import { track } from '@slayzone/telemetry/client'
import { useHomePanelState } from '@/hooks/useHomePanelVisibility'

export type HomePanel = 'kanban' | 'git' | 'editor' | 'processes' | 'tests' | 'automations'
const HOME_PANEL_ORDER: HomePanel[] = ['kanban', 'git', 'editor', 'processes', 'tests', 'automations']
const HOME_PANEL_SIZE_KEY: Record<HomePanel, string> = { kanban: 'kanban', git: 'diff', editor: 'editor', processes: 'processes', tests: 'tests', automations: 'automations' }
const HANDLE_WIDTH = 16

export { HOME_PANEL_ORDER, HOME_PANEL_SIZE_KEY }

export function useHomePanel(
  selectedProjectId: string,
  panelSizes: Record<string, number | 'auto'>
) {
  const [homePanelState, setHomePanelState] = useHomePanelState(selectedProjectId)
  const homePanelVisibility = homePanelState.visibility
  const visibilityRef = useRef(homePanelVisibility)
  visibilityRef.current = homePanelVisibility

  const setHomePanelVisibility = useCallback((updater: (prev: Record<HomePanel, boolean>) => Record<HomePanel, boolean>) => {
    const prev = visibilityRef.current
    const next = updater(prev)
    setHomePanelState(s => ({ ...s, visibility: next }))
    for (const key of Object.keys(next) as HomePanel[]) {
      if (next[key] !== prev[key]) track('panel_toggled', { panel: key, active: next[key], context: 'home' })
    }
  }, [setHomePanelState])

  const homeGitDefaultTab = homePanelState.gitTab as GitTabId
  const setHomeGitDefaultTab = useCallback((tab: GitTabId) => {
    setHomePanelState(s => ({ ...s, gitTab: tab }))
  }, [setHomePanelState])

  const homeGitPanelRef = useRef<UnifiedGitPanelHandle>(null)
  const homeEditorRef = useRef<FileEditorViewHandle>(null)
  const pendingHomeEditorFileRef = useRef<string | null>(null)
  const pendingHomeSearchToggleRef = useRef(false)

  const homeEditorRefCallback = useCallback((handle: FileEditorViewHandle | null) => {
    homeEditorRef.current = handle
    if (handle && pendingHomeEditorFileRef.current) {
      handle.openFile(pendingHomeEditorFileRef.current)
      pendingHomeEditorFileRef.current = null
    }
    if (handle && pendingHomeSearchToggleRef.current) {
      handle.toggleSearch()
      pendingHomeSearchToggleRef.current = false
    }
  }, [])

  const [homeQuickOpenVisible, setHomeQuickOpenVisible] = useState(false)

  // Container width tracking via ResizeObserver
  const [homeContainerWidth, setHomeContainerWidth] = useState(0)
  const homeRoRef = useRef<ResizeObserver | null>(null)
  const homeContainerRef = useCallback((el: HTMLDivElement | null) => {
    homeRoRef.current?.disconnect()
    if (el) {
      homeRoRef.current = new ResizeObserver(([entry]) => setHomeContainerWidth(entry.contentRect.width))
      homeRoRef.current.observe(el)
    }
  }, [])

  const homeResolvedWidths = useMemo(() => {
    const visible = HOME_PANEL_ORDER.filter(id => homePanelVisibility[id])
    const handleCount = Math.max(0, visible.length - 1)
    const available = homeContainerWidth - handleCount * HANDLE_WIDTH
    const sizeOf = (id: HomePanel) => panelSizes[HOME_PANEL_SIZE_KEY[id]] ?? 'auto'
    const autoCount = visible.filter(id => sizeOf(id) === 'auto').length
    const fixedSum = visible.filter(id => sizeOf(id) !== 'auto').reduce((s, id) => s + (sizeOf(id) as number), 0)
    const autoWidth = autoCount > 0 ? Math.max(200, (available - fixedSum) / autoCount) : 0
    return Object.fromEntries(visible.map(id => [id, sizeOf(id) === 'auto' ? autoWidth : (sizeOf(id) as number)]))
  }, [homeContainerWidth, homePanelVisibility, panelSizes])

  return {
    homePanelVisibility,
    setHomePanelVisibility,
    homeGitDefaultTab,
    setHomeGitDefaultTab,
    homeGitPanelRef,
    homeEditorRef,
    pendingHomeEditorFileRef,
    pendingHomeSearchToggleRef,
    homeEditorRefCallback,
    homeQuickOpenVisible,
    setHomeQuickOpenVisible,
    homeContainerRef,
    homeResolvedWidths
  }
}
