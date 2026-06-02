import { useState, useCallback, useRef, useMemo } from 'react'
import type { UnifiedGitPanelHandle, GitTabId } from '@slayzone/worktrees'
import type { FileEditorViewHandle } from '@slayzone/file-editor/client'
import { track } from '@slayzone/telemetry/client'
import { resolveFlexWidths } from '@slayzone/task/client/usePanelSizes'
import type { PanelSizes } from '@slayzone/task/shared'
import { useHomePanelState } from '@/hooks/useHomePanelVisibility'

export type HomePanel = 'kanban' | 'git' | 'editor' | 'processes' | 'tests' | 'automations'
const DEFAULT_HOME_PANEL_ORDER: HomePanel[] = [
  'kanban',
  'git',
  'editor',
  'processes',
  'tests',
  'automations'
]
// Identity map: each home panel stores its size under its own id. (Home has its
// own global store, so it no longer shares task key-space — the old git→'diff'
// remap is gone.)
const HOME_PANEL_SIZE_KEY: Record<HomePanel, string> = {
  kanban: 'kanban',
  git: 'git',
  editor: 'editor',
  processes: 'processes',
  tests: 'tests',
  automations: 'automations'
}
const homeMinWidth = (id: HomePanel): number => (id === 'kanban' ? 400 : 200)

export { DEFAULT_HOME_PANEL_ORDER as HOME_PANEL_ORDER, HOME_PANEL_SIZE_KEY }

export function useHomePanel(
  selectedProjectId: string,
  panelSizes: PanelSizes,
  userOrderedIds?: string[]
) {
  const HOME_PANEL_ORDER: HomePanel[] = useMemo(() => {
    if (!userOrderedIds || userOrderedIds.length === 0) return DEFAULT_HOME_PANEL_ORDER
    const known = new Set<string>(DEFAULT_HOME_PANEL_ORDER as string[])
    const valid = userOrderedIds.filter((id) => known.has(id)) as HomePanel[]
    const out: HomePanel[] = ['kanban']
    for (const id of valid) if (id !== 'kanban' && !out.includes(id)) out.push(id)
    for (const id of DEFAULT_HOME_PANEL_ORDER) if (!out.includes(id)) out.push(id)
    return out
  }, [userOrderedIds])
  const [homePanelState, setHomePanelState] = useHomePanelState(selectedProjectId)
  const homePanelVisibility = homePanelState.visibility
  const visibilityRef = useRef(homePanelVisibility)
  visibilityRef.current = homePanelVisibility

  const setHomePanelVisibility = useCallback(
    (updater: (prev: Record<HomePanel, boolean>) => Record<HomePanel, boolean>) => {
      const prev = visibilityRef.current
      const next = updater(prev)
      setHomePanelState((s) => ({ ...s, visibility: next }))
      for (const key of Object.keys(next) as HomePanel[]) {
        if (next[key] !== prev[key])
          track('panel_toggled', { panel: key, active: next[key], context: 'home' })
      }
    },
    [setHomePanelState]
  )

  const homeGitDefaultTab = homePanelState.gitTab as GitTabId
  const setHomeGitDefaultTab = useCallback(
    (tab: GitTabId) => {
      setHomePanelState((s) => ({ ...s, gitTab: tab }))
    },
    [setHomePanelState]
  )

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

  // Container width tracking via ResizeObserver
  const [homeContainerWidth, setHomeContainerWidth] = useState(0)
  const homeRoRef = useRef<ResizeObserver | null>(null)
  const homeContainerRef = useCallback((el: HTMLDivElement | null) => {
    homeRoRef.current?.disconnect()
    if (el) {
      homeRoRef.current = new ResizeObserver(([entry]) =>
        setHomeContainerWidth(entry.contentRect.width)
      )
      homeRoRef.current.observe(el)
    }
  }, [])

  const homeResolvedWidths = useMemo(() => {
    const entries = HOME_PANEL_ORDER.filter((id) => homePanelVisibility[id]).map((id) => ({
      key: HOME_PANEL_SIZE_KEY[id],
      min: homeMinWidth(id)
    }))
    return resolveFlexWidths(entries, panelSizes, homeContainerWidth)
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
    homeContainerRef,
    homeResolvedWidths,
    orderedHomePanelIds: HOME_PANEL_ORDER
  }
}
