import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import { scopeTracker } from '@slayzone/ui'
import { useTabStore, useDialogStore } from '@slayzone/settings'
import { buildCreateTaskDraftFromBrowserLink } from '@slayzone/task/shared'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { type GlobalAgentPanelState, type AgentStatusState } from '@slayzone/agent-panels'
import type {
  ProjectSettingsTab,
  ProjectIntegrationOnboardingProvider,
  ContextManagerSection
} from './constants'

type Tabs = ReturnType<typeof useTabStore.getState>['tabs']

export interface AppIpcListenersDeps {
  tabs: Tabs
  activeTabIndex: number
  closeTab: (index: number) => void
  guardTaskOpen: (taskId: string, fn: (id: string) => void, projectOverride?: Project) => void
  openTaskInBackground: (taskId: string) => void
  openTaskRef: RefObject<(taskId: string, projectOverride?: Project) => void>
  setActiveTabIndex: (index: number) => void
  selectedProjectId: string
  globalAgentPanelState: GlobalAgentPanelState
  setGlobalAgentPanelState: (updates: Partial<GlobalAgentPanelState>) => void
  agentStatusState: AgentStatusState
  setAgentStatusState: (updates: Partial<AgentStatusState>) => void
  setSettingsInitialTab: Dispatch<SetStateAction<string>>
  setSettingsInitialAiConfigSection: Dispatch<SetStateAction<ContextManagerSection | null>>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  projects: Project[]
  setProjectSettingsInitialTab: Dispatch<SetStateAction<ProjectSettingsTab>>
  setProjectSettingsOnboardingProvider: Dispatch<
    SetStateAction<ProjectIntegrationOnboardingProvider | null>
  >
  setEditingProject: Dispatch<SetStateAction<Project | null>>
  tasksMap: Map<string, Task>
}

// Main↔renderer subscriptions: window close, task open, panel toggles,
// settings, plus WebContentsView wiring (reload, zoom, shortcut forwarding,
// focus relay, create-task-from-link).
export function useAppIpcListeners(deps: AppIpcListenersDeps): void {
  const {
    tabs,
    activeTabIndex,
    closeTab,
    guardTaskOpen,
    openTaskInBackground,
    openTaskRef,
    setActiveTabIndex,
    selectedProjectId,
    globalAgentPanelState,
    setGlobalAgentPanelState,
    agentStatusState,
    setAgentStatusState,
    setSettingsInitialTab,
    setSettingsInitialAiConfigSection,
    setSettingsOpen,
    projects,
    setProjectSettingsInitialTab,
    setProjectSettingsOnboardingProvider,
    setEditingProject,
    tasksMap
  } = deps

  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const closeWindow = useMutation(trpc.app.window.close.mutationOptions())

  // Stable refs for the close subscriptions — onData reads these so it always
  // sees the latest tabs/activeTabIndex without re-binding the WS subscription.
  const closeActiveTaskRef = useRef<() => void>(() => {})
  closeActiveTaskRef.current = () => {
    const activeTab = tabs[activeTabIndex]
    if (activeTab?.type === 'task') closeTab(activeTabIndex)
    else void closeWindow.mutate()
  }
  const closeCurrentHomeRef = useRef<() => void>(() => {})
  closeCurrentHomeRef.current = () => {
    const activeTab = tabs[activeTabIndex]
    if (activeTab?.type === 'home') void closeWindow.mutate()
  }

  useSubscription(
    trpc.menu.onCloseActiveTask.subscriptionOptions(undefined, {
      onData: () => closeActiveTaskRef.current()
    })
  )
  useSubscription(
    trpc.menu.onCloseCurrentFocus.subscriptionOptions(undefined, {
      onData: () => closeCurrentHomeRef.current()
    })
  )
  useSubscription(
    trpc.menu.onCloseTask.subscriptionOptions(undefined, {
      onData: (taskId) => {
        useTabStore.getState().closeTabByTaskId(taskId)
        void trpcClient.processes.killTask.mutate({ taskId })
      }
    })
  )
  useSubscription(
    trpc.menu.onOpenTask.subscriptionOptions(undefined, {
      onData: ({ taskId, background }) => {
        if (background) guardTaskOpen(taskId, openTaskInBackground)
        else openTaskRef.current(taskId)
      }
    })
  )
  useSubscription(
    trpc.menu.onGoHome.subscriptionOptions(undefined, {
      onData: () => {
        const homeIndex = useTabStore.getState().tabs.findIndex((tab) => tab.type === 'home')
        if (homeIndex >= 0) setActiveTabIndex(homeIndex)
      }
    })
  )
  useSubscription(
    trpc.menu.onToggleGlobalAgentPanel.subscriptionOptions(undefined, {
      onData: () => {
        if (selectedProjectId) setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })
      }
    })
  )
  useSubscription(
    trpc.menu.onToggleAgentStatusPanel.subscriptionOptions(undefined, {
      onData: () => {
        setAgentStatusState({ isLocked: !agentStatusState.isLocked })
      }
    })
  )
  useSubscription(
    trpc.menu.onOpenSettings.subscriptionOptions(undefined, {
      onData: () => {
        setSettingsInitialTab('appearance')
        setSettingsInitialAiConfigSection(null)
        setSettingsOpen(true)
      }
    })
  )
  useSubscription(
    trpc.menu.onOpenProjectSettings.subscriptionOptions(undefined, {
      onData: () => {
        if (!selectedProjectId) return
        const project = projects.find((p) => p.id === selectedProjectId)
        if (!project) return
        setProjectSettingsInitialTab('general')
        setProjectSettingsOnboardingProvider(null)
        setEditingProject(project)
      }
    })
  )

  // Cmd+R: reload the active browser view (WebContentsView or webview fallback)
  useSubscription(
    trpc.menu.onReloadBrowser.subscriptionOptions(undefined, {
      onData: () => {
        // Find visible WebContentsView placeholder and reload via tRPC
        const placeholder = document.querySelector(
          '[data-browser-panel][data-view-id]'
        ) as HTMLElement | null
        const viewId = placeholder?.dataset.viewId
        if (viewId) {
          void trpcClient.app.browser.reload.mutate({ viewId })
          return
        }
        // Fallback: webview (multi-device grid)
        const webview = document.querySelector('[data-browser-panel] webview') as any
        if (webview?.reload) webview.reload()
      }
    })
  )

  // Cmd+Shift+R: reload the app
  useSubscription(
    trpc.menu.onReloadApp.subscriptionOptions(undefined, {
      onData: () => {
        window.location.reload()
      }
    })
  )

  // Keep app zoom on an explicit path instead of relying on Electron's default zoom roles.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return

      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        void trpcClient.app.meta.adjustZoom.mutate({ command: 'in' })
        return
      }

      if (e.key === '-') {
        e.preventDefault()
        void trpcClient.app.meta.adjustZoom.mutate({ command: 'out' })
        return
      }

      if (e.key === '0') {
        e.preventDefault()
        void trpcClient.app.meta.adjustZoom.mutate({ command: 'reset' })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [trpcClient])

  // Forward keyboard shortcuts from WebContentsView back into the DOM.
  // Forward WebContentsView keyboard shortcuts back into the renderer DOM (the
  // view is a separate web contents, so renderer key handlers never see them).
  useSubscription(
    trpc.app.browser.onShortcut.subscriptionOptions(undefined, {
      onData: (payload) => {
        // WebContentsView is a separate web contents — focusin never fires in
        // renderer when it has focus. Set browser scope before dispatching so
        // the shortcut registry sees the correct active scopes.
        // Web panels should NOT activate browser scope — browser-scoped shortcuts
        // (T for new tab, D for split) are wrong for web panels.
        if (payload.kind !== 'web-panel') {
          scopeTracker.setComponentScope('browser', payload.viewId)
        }
        // Dispatch on document (not window) so react-hotkeys-hook sees it —
        // it listens on document. Events on document also bubble to window,
        // so raw window.addEventListener handlers still work.
        // react-hotkeys-hook tracks pressed keys by e.code via keydown events.
        // Emit modifier keydowns first so the pressed-key set is correct, then
        // emit the actual key. Include code on all events.
        const key = payload.key
        const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
        const mods = {
          shiftKey: payload.shift,
          metaKey: payload.meta,
          ctrlKey: payload.control,
          altKey: payload.alt
        }
        if (payload.control)
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Control',
              code: 'ControlLeft',
              ...mods,
              bubbles: true
            })
          )
        if (payload.meta)
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Meta', code: 'MetaLeft', ...mods, bubbles: true })
          )
        if (payload.shift)
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', ...mods, bubbles: true })
          )
        if (payload.alt)
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', ...mods, bubbles: true })
          )
        document.dispatchEvent(new KeyboardEvent('keydown', { key, code, ...mods, bubbles: true }))
      }
    })
  )

  // When a WebContentsView gains focus, dispatch a synthetic focusin on the
  // owning panel element so TaskDetailPage's glow tracking picks it up.
  // Uses DOM lookup via data-view-id → closest data-panel-id to work for
  // both browser tabs and web panels.
  useSubscription(
    trpc.app.browser.onFocused.subscriptionOptions(undefined, {
      onData: ({ viewId }) => {
        const el = document.querySelector(`[data-view-id="${viewId}"]`)
        const panel = el?.closest('[data-panel-id]')
        if (panel) {
          panel.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        }
      }
    })
  )

  // Open the create-task dialog seeded from a browser-link intent (context menu
  // / modified-click in a WebContentsView).
  useSubscription(
    trpc.app.browser.onCreateTaskFromLink.subscriptionOptions(undefined, {
      onData: (intent) => {
        const sourceTask = tasksMap.get(intent.taskId)
        const fallbackProjectId = sourceTask?.project_id ?? selectedProjectId ?? projects[0]?.id
        useDialogStore.getState().openCreateTask({
          ...buildCreateTaskDraftFromBrowserLink(intent.url, intent.linkText),
          projectId: fallbackProjectId
        })
      }
    })
  )
}
