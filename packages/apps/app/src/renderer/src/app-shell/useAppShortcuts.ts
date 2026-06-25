import {
  useCallback,
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import {
  useGuardedHotkeys,
  matchesShortcut,
  useShortcutStore,
  shortcutDefinitions,
  withModalGuard,
  toast
} from '@slayzone/ui'
import { useUndo } from '@slayzone/ui'
import { useTabStore, useDialogStore, type SearchFileContext } from '@slayzone/settings'
import { track, trackShortcut } from '@slayzone/telemetry/client'
import type { Project } from '@slayzone/projects/shared'
import { useHomePanel } from '@slayzone/home/client'
import { useVisibleTabs } from '@/hooks/useVisibleTabs'
import { usePanelConfig } from '@slayzone/task/client/usePanelConfig'
import { type GlobalAgentPanelState, type AgentStatusState } from '@slayzone/agent-panels'

type Tabs = ReturnType<typeof useTabStore.getState>['tabs']
type VisibleTabsApi = ReturnType<typeof useVisibleTabs>
type UndoApi = ReturnType<typeof useUndo>

export interface AppShortcutsDeps {
  projects: Project[]
  homePanel: ReturnType<typeof useHomePanel>
  selectedProjectId: string
  tabs: Tabs
  activeTabIndex: number
  visibleTabs: VisibleTabsApi['visibleTabs']
  toFullIndex: VisibleTabsApi['toFullIndex']
  toVisibleIndex: VisibleTabsApi['toVisibleIndex']
  tabCycleOrder: number[]
  setActiveTabIndex: (index: number) => void
  setSelectedProjectId: (id: string) => void
  reopenClosedTab: () => void
  openTaskRef: RefObject<(taskId: string, projectOverride?: Project) => void>
  undo: UndoApi['undo']
  redo: UndoApi['redo']
  zenMode: boolean
  setZenMode: Dispatch<SetStateAction<boolean>>
  explodeMode: boolean
  setExplodeMode: Dispatch<SetStateAction<boolean>>
  openTaskIds: string[]
  globalAgentPanelState: GlobalAgentPanelState
  setGlobalAgentPanelState: (updates: Partial<GlobalAgentPanelState>) => void
  agentStatusState: AgentStatusState
  setAgentStatusState: (updates: Partial<AgentStatusState>) => void
  isHomePanelEnabled: ReturnType<typeof usePanelConfig>['isBuiltinEnabled']
  testsPanelEnabled: boolean
}

// All global keyboard shortcuts: the react-hotkeys registrations plus the
// home-tab panel keydown listener. Owns key resolution (`getKeys`) and the
// home file-palette context; everything else is wired in via deps.
export function useAppShortcuts(deps: AppShortcutsDeps): void {
  const {
    projects,
    homePanel,
    selectedProjectId,
    tabs,
    activeTabIndex,
    visibleTabs,
    toFullIndex,
    toVisibleIndex,
    tabCycleOrder,
    setActiveTabIndex,
    setSelectedProjectId,
    reopenClosedTab,
    openTaskRef,
    undo,
    redo,
    zenMode,
    setZenMode,
    explodeMode,
    setExplodeMode,
    openTaskIds,
    globalAgentPanelState,
    setGlobalAgentPanelState,
    agentStatusState,
    setAgentStatusState,
    isHomePanelEnabled,
    testsPanelEnabled
  } = deps

  // Shortcut store (dynamic hotkey bindings)
  const overrides = useShortcutStore((s) => s.overrides)
  const isRecording = useShortcutStore((s) => s.isRecording)
  // Resolve effective keys from overrides + defaults. Subscribing to `overrides` above
  // ensures re-render when shortcuts change, so useHotkeys picks up new key strings.
  const getKeys = useCallback(
    (id: string): string => {
      if (overrides[id]) return overrides[id]
      const def = shortcutDefinitions.find((d) => d.id === id)
      return def?.defaultKeys ?? ''
    },
    [overrides]
  )
  useEffect(() => {
    useShortcutStore.getState().load()
  }, [])

  // Keyboard shortcuts
  useGuardedHotkeys(
    getKeys('new-task'),
    (e) => {
      if (projects.length > 0) {
        e.preventDefault()
        trackShortcut(getKeys('new-task'))
        useDialogStore.getState().openCreateTask()
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  // Build a snapshot of the home file-open context for the unified palette.
  // Captured into the dialog payload at the moment the shortcut fires; cleared on close.
  const buildHomeFileContext = useCallback((): SearchFileContext | undefined => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project?.path) return undefined
    return {
      projectPath: project.path,
      openFile: (filePath) => {
        if (homePanel.homeEditorRef.current) {
          if (!homePanel.homePanelVisibility.editor) {
            homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
          }
          homePanel.homeEditorRef.current.openFile(filePath)
        } else {
          homePanel.pendingHomeEditorFileRef.current = filePath
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
        }
      }
    }
  }, [projects, selectedProjectId, homePanel])

  useGuardedHotkeys(
    getKeys('search'),
    (e) => {
      // Only fire on home tab; TaskDetailPage owns the search shortcut when a task tab is active.
      if (tabs[activeTabIndex]?.type !== 'home') return
      e.preventDefault()
      trackShortcut(getKeys('search'))
      useDialogStore.getState().openSearch({ fileContext: buildHomeFileContext() })
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    'mod+z',
    async (e) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
      e.preventDefault()
      const label = await undo()
      if (label) {
        track('undo_used')
        toast(`Undid: ${label}`)
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    'mod+shift+z',
    async (e) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
      e.preventDefault()
      const label = await redo()
      if (label) {
        track('redo_used')
        toast(`Redid: ${label}`)
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    'mod+1,mod+2,mod+3,mod+4,mod+5,mod+6,mod+7,mod+8,mod+9',
    (e) => {
      e.preventDefault()
      const num = parseInt(e.key, 10)
      if (num < visibleTabs.length) {
        setActiveTabIndex(toFullIndex(num))
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  // Cycle through open task tabs (skip the home tab), wrapping at the edges.
  const navigateTaskTabs = useCallback(
    (direction: 1 | -1) => {
      // Task tabs live at visibleIndex 1..length-1 (visibleTabs[0] is home).
      if (visibleTabs.length <= 1) return
      const taskCount = visibleTabs.length - 1
      const visibleIdx = toVisibleIndex(useTabStore.getState().activeTabIndex)
      // Treat home / unknown position as "before the first task tab" so
      // next jumps to first and prev jumps to last — same as Chrome.
      const currentTaskPos = visibleIdx >= 1 ? visibleIdx - 1 : direction === 1 ? -1 : 0
      const nextTaskPos = (currentTaskPos + direction + taskCount) % taskCount
      useTabStore.getState().setActiveView('tabs')
      setActiveTabIndex(toFullIndex(nextTaskPos + 1))
    },
    [visibleTabs.length, toFullIndex, toVisibleIndex, setActiveTabIndex]
  )

  useGuardedHotkeys(
    getKeys('next-task-tab'),
    (e) => {
      // macOS Cmd+Option+Right is "next word" in text fields; don't hijack.
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return
      if (el.isContentEditable || el.getAttribute('role') === 'textbox') return
      if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
      if (el.closest?.('.milkdown') || el.closest?.('.ProseMirror')) return
      e.preventDefault()
      navigateTaskTabs(1)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('prev-task-tab'),
    (e) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return
      if (el.isContentEditable || el.getAttribute('role') === 'textbox') return
      if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
      if (el.closest?.('.milkdown') || el.closest?.('.ProseMirror')) return
      e.preventDefault()
      navigateTaskTabs(-1)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    'mod+shift+1,mod+shift+2,mod+shift+3,mod+shift+4,mod+shift+5,mod+shift+6,mod+shift+7,mod+shift+8,mod+shift+9',
    (e) => {
      e.preventDefault()
      const num = parseInt(e.code.replace('Digit', ''), 10)
      if (num > 0 && num <= projects.length) {
        setSelectedProjectId(projects[num - 1].id)
        setActiveTabIndex(0)
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  const navigateCycle = useCallback(
    (direction: 1 | -1) => {
      const cycle = tabCycleOrder.filter((i) => toVisibleIndex(i) >= 0)
      if (cycle.length === 0) return
      const { activeTabIndex: idx, activeView: view } = useTabStore.getState()
      const pos = view === 'context' ? -1 : cycle.indexOf(idx)
      const current = pos >= 0 ? pos : 0
      const target = cycle[(current + direction + cycle.length) % cycle.length]
      useTabStore.getState().setActiveView('tabs')
      setActiveTabIndex(target)
    },
    [tabCycleOrder, toVisibleIndex, setActiveTabIndex]
  )

  const cycleSidebarTreeItems = useCallback((direction: 1 | -1) => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-sidebar-tree-item="task"][data-task-id]')
    )
    if (items.length === 0) return
    const activeIdx = items.findIndex((el) => el.dataset.active === 'true')
    const nextIdx =
      activeIdx === -1
        ? direction === 1
          ? 0
          : items.length - 1
        : (activeIdx + direction + items.length) % items.length
    const id = items[nextIdx]?.dataset.taskId
    if (id) openTaskRef.current(id)
  }, [])

  useGuardedHotkeys(
    getKeys('next-tab'),
    (e) => {
      e.preventDefault()
      const { sidebarView: sv } = useTabStore.getState()
      if (sv === 'tree') cycleSidebarTreeItems(1)
      else navigateCycle(1)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('prev-tab'),
    (e) => {
      e.preventDefault()
      const { sidebarView: sv } = useTabStore.getState()
      if (sv === 'tree') cycleSidebarTreeItems(-1)
      else navigateCycle(-1)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('reopen-closed-tab'),
    (e) => {
      e.preventDefault()
      track('tab_reopened')
      reopenClosedTab()
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('toggle-project-tabs'),
    (e) => {
      e.preventDefault()
      trackShortcut(getKeys('toggle-project-tabs'))
      useTabStore.getState().toggleProjectScopedTabs()
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('complete-close-tab'),
    (e) => {
      e.preventDefault()
      if (tabs[activeTabIndex].type === 'task') useDialogStore.getState().openCompleteTaskDialog()
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('zen-mode'),
    (e) => {
      e.preventDefault()
      track('zen_mode_toggled')
      trackShortcut(getKeys('zen-mode'))
      setZenMode((prev) => !prev)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('sidebar-auto-hide'),
    (e) => {
      e.preventDefault()
      trackShortcut(getKeys('sidebar-auto-hide'))
      useTabStore.getState().setSidebarAutoHide(!useTabStore.getState().sidebarAutoHide)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('explode-mode'),
    (e) => {
      e.preventDefault()
      if (openTaskIds.length >= 2) {
        track('explode_mode_toggled')
        trackShortcut(getKeys('explode-mode'))
        setExplodeMode((prev) => !prev)
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('exit-zen-explode'),
    () => {
      if (explodeMode) setExplodeMode(false)
      else if (zenMode) setZenMode(false)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('global-agent-panel'),
    (e) => {
      e.preventDefault()
      trackShortcut(getKeys('global-agent-panel'))
      if (selectedProjectId) setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('agent-status-panel'),
    (e) => {
      e.preventDefault()
      trackShortcut(getKeys('agent-status-panel'))
      setAgentStatusState({ isLocked: !agentStatusState.isLocked })
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  // Home tab panel shortcuts
  useEffect(() => {
    const handleKeyDown = withModalGuard((e: KeyboardEvent): void => {
      if (tabs[activeTabIndex]?.type !== 'home') return
      if (!selectedProjectId) return
      if (isRecording) return

      // These shortcuts work even inside editors (no binding conflict)
      if (matchesShortcut(e, getKeys('editor-search')) && isHomePanelEnabled('editor', 'home')) {
        e.preventDefault()
        if (homePanel.homeEditorRef.current) {
          if (!homePanel.homePanelVisibility.editor)
            homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
          homePanel.homeEditorRef.current.toggleSearch()
        } else {
          homePanel.pendingHomeSearchToggleRef.current = true
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
        }
        return
      }

      // Git Diff (panel-git-diff)
      if (matchesShortcut(e, getKeys('panel-git-diff')) && isHomePanelEnabled('git', 'home')) {
        e.preventDefault()
        if (!homePanel.homePanelVisibility.git) {
          homePanel.setHomeGitDefaultTab('changes')
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, git: true }))
        } else if (homePanel.homeGitPanelRef.current?.getActiveTab() === 'changes') {
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, git: false }))
        } else {
          homePanel.homeGitPanelRef.current?.switchToTab('changes')
        }
        return
      }

      // Git (panel-git)
      if (matchesShortcut(e, getKeys('panel-git')) && isHomePanelEnabled('git', 'home')) {
        e.preventDefault()
        if (!homePanel.homePanelVisibility.git) {
          homePanel.setHomeGitDefaultTab('general')
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, git: true }))
        } else if (homePanel.homeGitPanelRef.current?.getActiveTab() === 'general') {
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, git: false }))
        } else {
          homePanel.homeGitPanelRef.current?.switchToTab('general')
        }
      } else if (
        matchesShortcut(e, getKeys('panel-editor')) &&
        isHomePanelEnabled('editor', 'home')
      ) {
        e.preventDefault()
        homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: !prev.editor }))
      } else if (
        matchesShortcut(e, getKeys('panel-processes')) &&
        isHomePanelEnabled('processes', 'home')
      ) {
        e.preventDefault()
        homePanel.setHomePanelVisibility((prev) => ({ ...prev, processes: !prev.processes }))
      } else if (
        matchesShortcut(e, getKeys('panel-tests')) &&
        testsPanelEnabled &&
        isHomePanelEnabled('tests', 'home')
      ) {
        e.preventDefault()
        homePanel.setHomePanelVisibility((prev) => ({ ...prev, tests: !prev.tests }))
      } else if (
        matchesShortcut(e, getKeys('panel-automations')) &&
        isHomePanelEnabled('automations', 'home')
      ) {
        e.preventDefault()
        homePanel.setHomePanelVisibility((prev) => ({ ...prev, automations: !prev.automations }))
      }
    })
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    tabs,
    activeTabIndex,
    selectedProjectId,
    homePanel.homePanelVisibility,
    getKeys,
    isRecording,
    buildHomeFileContext
  ])
}
