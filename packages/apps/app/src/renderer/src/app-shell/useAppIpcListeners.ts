import { useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { getClientHost, useClientHostEvent } from '@slayzone/transport/client'
import { useTRPC } from '../trpc'
import { scopeTracker, useStableCallback } from '@slayzone/ui'
import { useTabStore } from '@slayzone/tabs-state'
import {
  callBrowserHost,
  useBrowserEngagementForwarder,
  useBrowserHostEvent
} from '@slayzone/task-browser/client'
import { useDialogStore } from '@slayzone/dialogs'
import { buildCreateTaskDraftFromBrowserLink } from '@slayzone/task-contracts'
import type { Task } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
import { type GlobalAgentPanelState, type AgentStatusState } from '@slayzone/agent-panels'
import type { ProjectSettingsTab } from './constants'

import { openSettings } from '@slayzone/settings'

export interface AppIpcListenersDeps {
  closeTab: (index: number) => void
  setActiveTabIndex: (index: number) => void
  selectedProjectId: string
  globalAgentPanelState: GlobalAgentPanelState
  setGlobalAgentPanelState: (updates: Partial<GlobalAgentPanelState>) => void
  agentStatusState: AgentStatusState
  setAgentStatusState: (updates: Partial<AgentStatusState>) => void
  projects: Project[]
  openProjectSettings: (project: Project, options?: { initialTab?: ProjectSettingsTab }) => void
  tasksMap: Map<string, Task>
}

// Main↔renderer subscriptions: window close, panel toggles,
// settings, plus WebContentsView wiring (reload, zoom, shortcut forwarding,
// focus relay, create-task-from-link).
export function useAppIpcListeners(deps: AppIpcListenersDeps): void {
  const {
    closeTab,
    setActiveTabIndex,
    selectedProjectId,
    globalAgentPanelState,
    setGlobalAgentPanelState,
    agentStatusState,
    setAgentStatusState,
    projects,
    openProjectSettings,
    tasksMap
  } = deps

  const trpc = useTRPC()
  const closeWindow = useMutation(trpc.app.window.close.mutationOptions())

  // Stable handlers for the close subscriptions: they read the active tab from the
  // store when the event fires (the shell does not re-render on a tab switch) and
  // never re-bind the WS subscription.
  const closeActiveTask = useStableCallback(() => {
    const { tabs, activeTabIndex } = useTabStore.getState()
    if (tabs[activeTabIndex]?.type === 'task') closeTab(activeTabIndex)
    else void closeWindow.mutate()
  })
  const closeCurrentHome = useStableCallback(() => {
    const { tabs, activeTabIndex } = useTabStore.getState()
    if (tabs[activeTabIndex]?.type === 'home') void closeWindow.mutate()
  })

  // Native menu / accelerator events come from THIS device's client host, never a
  // hub (a hub must not drive this window's menu actions). Task open/close requests
  // come from every hub: `HubTaskEvents`.
  useClientHostEvent('close-active-task', closeActiveTask)
  useClientHostEvent('close-current-focus', closeCurrentHome)
  useClientHostEvent('go-home', () => {
    const homeIndex = useTabStore.getState().tabs.findIndex((tab) => tab.type === 'home')
    if (homeIndex >= 0) setActiveTabIndex(homeIndex)
  })
  useClientHostEvent('toggle-global-agent-panel', () => {
    if (selectedProjectId) setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })
  })
  useClientHostEvent('toggle-agent-status-panel', () => {
    setAgentStatusState({ isLocked: !agentStatusState.isLocked })
  })
  useClientHostEvent('open-settings', () => openSettings())
  useClientHostEvent('open-project-settings', () => {
    if (!selectedProjectId) return
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    openProjectSettings(project)
  })

  // Cmd+R: reload the active browser view (WebContentsView or webview fallback)
  useClientHostEvent('reload-browser', () => {
    // Find visible WebContentsView placeholder and reload it on this device's host
    const placeholder = document.querySelector(
      '[data-browser-panel][data-view-id]'
    ) as HTMLElement | null
    const viewId = placeholder?.dataset.viewId
    if (viewId) {
      // A menu event: the browser host counts it as the user's only if main saw the key.
      callBrowserHost('view.reload', viewId, undefined, 'shortcut')
      return
    }
    // Fallback: webview (multi-device grid). <webview> is an Electron custom
    // element, so the DOM lib types it as a bare HTMLElement — narrow to just
    // the one method we call rather than pulling in the Electron typings.
    type ReloadableWebview = HTMLElement & { reload?: () => void }
    const webview = document.querySelector<ReloadableWebview>('[data-browser-panel] webview')
    if (webview?.reload) webview.reload()
  })

  // Cmd+Shift+R: reload the app
  useClientHostEvent('reload-app', () => {
    window.location.reload()
  })

  // Keep app zoom on an explicit path instead of relying on Electron's default zoom roles.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return

      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        void getClientHost().call('zoom.adjust', 'in')
        return
      }

      if (e.key === '-') {
        e.preventDefault()
        void getClientHost().call('zoom.adjust', 'out')
        return
      }

      if (e.key === '0') {
        e.preventDefault()
        void getClientHost().call('zoom.adjust', 'reset')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Forward keyboard shortcuts from WebContentsView back into the DOM.
  // Forward WebContentsView keyboard shortcuts back into the renderer DOM (the
  // view is a separate web contents, so renderer key handlers never see them).
  // Input in any web view (browser tab or web panel, panel open or not) → the task's
  // hub: idle-close and `slay browser` ownership.
  useBrowserEngagementForwarder()

  useBrowserHostEvent('shortcut', (payload) => {
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
        new KeyboardEvent('keydown', {
          key: 'Shift',
          code: 'ShiftLeft',
          ...mods,
          bubbles: true
        })
      )
    if (payload.alt)
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', ...mods, bubbles: true })
      )
    document.dispatchEvent(new KeyboardEvent('keydown', { key, code, ...mods, bubbles: true }))
  })

  // When a WebContentsView gains focus, dispatch a synthetic focusin on the
  // owning panel element so TaskDetailPage's glow tracking picks it up.
  // Uses DOM lookup via data-view-id → closest data-panel-id to work for
  // both browser tabs and web panels.
  useBrowserHostEvent('focused', ({ viewId }) => {
    const el = document.querySelector(`[data-view-id="${viewId}"]`)
    const panel = el?.closest('[data-panel-id]')
    if (panel) {
      panel.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    }
  })

  // Open the create-task dialog seeded from a browser-link intent (context menu
  // / modified-click in a WebContentsView).
  useBrowserHostEvent('create-task-from-link', (intent) => {
    const sourceTask = tasksMap.get(intent.taskId)
    const fallbackProjectId = sourceTask?.project_id ?? selectedProjectId ?? projects[0]?.id
    useDialogStore.getState().openCreateTask({
      ...buildCreateTaskDraftFromBrowserLink(intent.url, intent.linkText),
      projectId: fallbackProjectId
    })
  })
}
