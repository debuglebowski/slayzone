import { useState, useEffect, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from 'react'
import { usePty } from '@slayzone/terminal'
import { Terminal as TerminalView } from '@slayzone/terminal/client/Terminal'
import type { TerminalMode } from '@slayzone/terminal/shared'
import { matchesShortcut, useShortcutStore, withModalGuard, getThemeChrome, getChromeStyleOverrides } from '@slayzone/ui'
import { useTheme } from '@slayzone/settings/client'
import { useTaskTerminals } from './useTaskTerminals'
import { TerminalTabBar, type TerminalTabBarHandle } from './TerminalTabBar'
import { TerminalSplitGroup, type TerminalSplitGroupHandle } from './TerminalSplitGroup'
import { ManagerSidebar, type ManagerTask } from './ManagerSidebar'
import type { TabDisplayMode } from '../shared/types'

export interface TerminalContainerHandle {
  closeActiveGroup: () => Promise<boolean>
  setMainDisplayMode: (target: TabDisplayMode) => Promise<void>
}

interface TerminalContainerProps {
  taskId: string
  cwd: string
  defaultMode: TerminalMode
  conversationId?: string | null
  existingConversationId?: string | null
  supportsSessionId?: boolean
  initialPrompt?: string | null
  providerFlags?: string
  executionContext?: import('@slayzone/terminal/shared').ExecutionContext | null
  isActive?: boolean
  /** Owns keyboard shortcuts (Cmd+D, Cmd+T). Defaults to `isActive`. In explode mode, only the focused cell has this true. */
  hasShortcutFocus?: boolean
  focusRequestId?: number
  onConversationCreated?: (conversationId: string) => void
  onSessionInvalid?: () => void
  onReady?: (api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => void
  onFirstInput?: () => void
  onRetry?: () => void
  onFocusRequestHandled?: (requestId: number) => void
  onMainTabActiveChange?: (isMainActive: boolean) => void
  onMainDisplayModeChange?: (mode: TabDisplayMode) => void
  onOpenUrl?: (url: string) => void
  onOpenFile?: (filePath: string, options?: { position?: { line: number; col?: number } }) => void
  onMainReset?: () => void
  rightContent?: React.ReactNode
  overlay?: React.ReactNode
  /** Title of the root task — shown as "Main" row label in manager sidebar. */
  taskTitle?: string
  /** Status of the root task — drives the manager-sidebar root icon + strikethrough. */
  taskStatus?: string
  /** Progress of the root task (0-100) — drives the progress ring around the root pty dot. */
  taskProgress?: number
  /** Persisted orchestrator/manager-mode toggle state (from task.manager_mode). */
  initialManagerMode?: boolean
}

export const TerminalContainer = forwardRef<TerminalContainerHandle, TerminalContainerProps>(function TerminalContainer({
  taskId,
  cwd,
  defaultMode,
  conversationId,
  existingConversationId,
  supportsSessionId,
  initialPrompt,
  providerFlags,
  executionContext,
  isActive = true,
  hasShortcutFocus,
  focusRequestId = 0,
  onConversationCreated,
  onSessionInvalid,
  onReady,
  onFirstInput,
  onRetry,
  onFocusRequestHandled,
  onMainTabActiveChange,
  onMainDisplayModeChange,
  onOpenUrl,
  onOpenFile,
  onMainReset,
  rightContent,
  overlay,
  taskTitle,
  taskStatus,
  taskProgress,
  initialManagerMode,
}: TerminalContainerProps, ref) {
  const {
    tabs,
    groups,
    activeGroupId,
    setActiveGroupId,
    createTab,
    splitTab,
    closeTab,
    movePane,
    renameTab,
    setTabDisplayMode,
    getSessionId
  } = useTaskTerminals(taskId, defaultMode)

  // Owns keyboard shortcuts; falls back to isActive so non-explode callers need not set it.
  const shortcutActive = hasShortcutFocus ?? isActive

  // Manager mode: optional left sidebar showing subtask tree; selecting a subtask
  // swaps the output area to that subtask's main PTY session. Gated by labs flag.
  // Persisted per-task via tasks.manager_mode column.
  const agentManagerEnabled = window.api.app.isAgentManagerEnabledSync
  const [managerMode, setManagerMode] = useState<boolean>(initialManagerMode ?? false)
  const [managerSelectedTask, setManagerSelectedTask] = useState<ManagerTask | null>(null)
  const handleManagerToggle = useCallback(() => {
    setManagerMode((v) => {
      const next = !v
      if (v) setManagerSelectedTask(null)
      window.api.db.updateTask({ id: taskId, managerMode: next }).catch(() => {})
      return next
    })
  }, [taskId])
  const handleManagerSelect = useCallback((task: ManagerTask | null) => {
    setManagerSelectedTask(task)
  }, [])
  // Reset selection + sync mode from task prop when switching task.
  useEffect(() => {
    setManagerSelectedTask(null)
    setManagerMode(initialManagerMode ?? false)
  }, [taskId, initialManagerMode])

  // Track whether task has any direct subtasks — toggle button hidden otherwise.
  // `loaded` guards the auto-exit effect so it doesn't fire before the first fetch resolves
  // (which would incorrectly clear a persisted managerMode on mount).
  const [subtaskInfo, setSubtaskInfo] = useState<{ loaded: boolean; has: boolean }>({ loaded: false, has: false })
  useEffect(() => {
    let cancelled = false
    setSubtaskInfo({ loaded: false, has: false })
    const refresh = (): void => {
      window.api.db.getSubTasks(taskId)
        .then((rows) => { if (!cancelled) setSubtaskInfo({ loaded: true, has: rows.length > 0 }) })
        .catch(() => {})
    }
    refresh()
    const cleanup = window.api?.app?.onTasksChanged?.(refresh)
    return () => { cancelled = true; cleanup?.() }
  }, [taskId])
  const hasSubtasks = subtaskInfo.has

  // Auto-exit manager mode if subtasks disappear — persist the off state.
  useEffect(() => {
    if (subtaskInfo.loaded && !subtaskInfo.has && managerMode) {
      setManagerMode(false)
      setManagerSelectedTask(null)
      window.api.db.updateTask({ id: taskId, managerMode: false }).catch(() => {})
    }
  }, [subtaskInfo, managerMode, taskId])

  const { subscribePrompt, subscribeTitle } = usePty()
  const { terminalOverrideThemeId, contentVariant } = useTheme()
  const terminalPanelStyle = useMemo(() => {
    if (!terminalOverrideThemeId) return undefined
    return getChromeStyleOverrides(getThemeChrome(terminalOverrideThemeId, contentVariant))
  }, [terminalOverrideThemeId, contentVariant])
  const splitGroupRef = useRef<TerminalSplitGroupHandle | null>(null)
  const tabBarRef = useRef<TerminalTabBarHandle | null>(null)
  const pendingFocusRef = useRef<string | boolean>(isActive)
  const terminalApiRef = useRef<{
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  } | null>(null)
  const lastHandledFocusRequestRef = useRef(0)

  // Get active group
  const activeGroup = groups.find(g => g.id === activeGroupId)
  const mainGroupId = groups.find((group) => group.tabs.some((tab) => tab.isMain))?.id ?? null

  // Notify parent when main tab active state changes
  useEffect(() => {
    onMainTabActiveChange?.(activeGroup?.isMain ?? false)
  }, [activeGroup?.isMain, onMainTabActiveChange])

  // Notify parent when main tab display mode changes
  const mainTabDisplayMode = tabs.find(t => t.isMain)?.displayMode
  useEffect(() => {
    if (mainTabDisplayMode) onMainDisplayModeChange?.(mainTabDisplayMode)
  }, [mainTabDisplayMode, onMainDisplayModeChange])

  // Forward main tab state changes to task-level callbacks
  useEffect(() => {
    const mainTab = tabs.find(t => t.isMain)
    if (!mainTab) return
    const mainSessionId = getSessionId(mainTab.id)
    return subscribePrompt(mainSessionId, () => {
      // Main tab prompt events could trigger task-level UI updates
    })
  }, [taskId, tabs, getSessionId, subscribePrompt])

  // Track terminal process titles for tab labels
  const [isManagerResizing, setIsManagerResizing] = useState(false)
  const [terminalTitles, setTerminalTitles] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    const unsubs: Array<() => void> = []
    for (const tab of tabs) {
      if (tab.isMain) continue
      const sessionId = getSessionId(tab.id)
      const unsub = subscribeTitle(sessionId, (title) => {
        setTerminalTitles(prev => {
          const next = new Map(prev)
          if (title) {
            next.set(tab.id, title)
          } else {
            next.delete(tab.id)
          }
          return next
        })
      })
      unsubs.push(unsub)
    }
    return () => unsubs.forEach(u => u())
  }, [tabs, getSessionId, subscribeTitle])

  // Keyboard shortcuts
  useEffect(() => {
    if (!shortcutActive) return
    if (useShortcutStore.getState().isRecording) return

    const handleKeyDown = withModalGuard((e: KeyboardEvent) => {
      if (useShortcutStore.getState().isRecording) return
      // New group
      if (matchesShortcut(e, useShortcutStore.getState().getKeys('terminal-new-group'))) {
        e.preventDefault()
        pendingFocusRef.current = true
        createTab()
      }
      // Split current group
      if (matchesShortcut(e, useShortcutStore.getState().getKeys('terminal-split')) && activeGroup) {
        e.preventDefault()
        const lastPane = activeGroup.tabs[activeGroup.tabs.length - 1]
        if (lastPane) {
          splitTab(lastPane.id).then(newTab => {
            if (newTab) pendingFocusRef.current = getSessionId(newTab.id)
          })
        }
      }
    })

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcutActive, activeGroup, createTab, splitTab, getSessionId])

  // Handle conversation created - only for main tab
  const handleConversationCreated = useCallback((convId: string) => {
    onConversationCreated?.(convId)
  }, [onConversationCreated])

  // Split the active group — add a new pane
  const handleSplitGroup = useCallback((groupId: string) => {
    const group = groups.find(g => g.id === groupId)
    if (!group) return
    const lastPane = group.tabs[group.tabs.length - 1]
    if (lastPane) {
      splitTab(lastPane.id).then(newTab => {
        if (newTab) pendingFocusRef.current = getSessionId(newTab.id)
      })
    }
  }, [groups, splitTab, getSessionId])

  // Close an entire group (all its panes)
  const closeGroup = useCallback(async (groupId: string) => {
    const group = groups.find(g => g.id === groupId)
    if (!group || group.isMain) return
    for (const tab of [...group.tabs].reverse()) {
      await closeTab(tab.id)
    }
  }, [groups, closeTab])

  const tryApplyFocusRequest = useCallback(() => {
    if (focusRequestId <= 0 || focusRequestId <= lastHandledFocusRequestRef.current) return
    if (!isActive || !terminalApiRef.current) return

    if (mainGroupId && activeGroupId !== mainGroupId) {
      pendingFocusRef.current = true
      setActiveGroupId(mainGroupId)
      return
    }

    splitGroupRef.current?.focus()
    lastHandledFocusRequestRef.current = focusRequestId
    onFocusRequestHandled?.(focusRequestId)
  }, [
    focusRequestId,
    isActive,
    mainGroupId,
    activeGroupId,
    setActiveGroupId,
    onFocusRequestHandled
  ])

  useEffect(() => {
    tryApplyFocusRequest()
  }, [tryApplyFocusRequest])

  // Focus terminal when task becomes the shortcut-focused cell (or active in non-explode)
  useEffect(() => {
    if (!shortcutActive) return
    if (splitGroupRef.current) {
      splitGroupRef.current.focus()
    } else {
      pendingFocusRef.current = true
    }
  }, [shortcutActive])

  const handlePaneAttached = useCallback((api: { sessionId: string; focus: () => void }) => {
    const pending = pendingFocusRef.current
    if (pending === true || pending === api.sessionId) {
      api.focus()
      pendingFocusRef.current = false
    }
  }, [])

  // Handle terminal ready - pass up to parent (main tab's API)
  const handleTerminalReady = useCallback((api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => {
    terminalApiRef.current = api
    onReady?.(api)
    tryApplyFocusRequest()
  }, [onReady, tryApplyFocusRequest])

  // Close a group and focus the adjacent group's terminal
  const closeGroupAndFocusAdjacent = useCallback(async (groupId: string) => {
    const groupIndex = groups.findIndex(g => g.id === groupId)
    if (groupIndex === -1 || groups[groupIndex]?.isMain) return
    const adjacentGroup = groups[groupIndex > 0 ? groupIndex - 1 : 1]
    await closeGroup(groupId)
    if (adjacentGroup) {
      pendingFocusRef.current = true
      setActiveGroupId(adjacentGroup.id)
    }
  }, [groups, closeGroup, setActiveGroupId])

  useImperativeHandle(ref, () => ({
    setMainDisplayMode: async (target: TabDisplayMode): Promise<void> => {
      const mainTab = tabs.find(t => t.isMain)
      if (!mainTab) return
      await setTabDisplayMode(mainTab.id, target)
    },
    closeActiveGroup: async (): Promise<boolean> => {
      const active = document.activeElement as HTMLElement | null
      const paneEl = active?.closest('[data-session-id]')
      const sessionId = paneEl?.getAttribute('data-session-id')

      if (sessionId) {
        const tabId = sessionId.substring(taskId.length + 1)
        const group = groups.find(g => g.tabs.some(t => t.id === tabId))
        if (!group) return false
        if (group.isMain && group.tabs.length === 1) return false

        if (group.tabs.length > 1) {
          // Multiple panes: close focused pane, focus adjacent pane in same group
          const paneIndex = group.tabs.findIndex(t => t.id === tabId)
          const adjacentTab = group.tabs[paneIndex > 0 ? paneIndex - 1 : 1]
          await closeTab(tabId)
          if (adjacentTab) {
            splitGroupRef.current?.focus(`${taskId}:${adjacentTab.id}`)
          }
        } else {
          // Last pane in group: close group and focus adjacent group
          await closeGroupAndFocusAdjacent(group.id)
        }
        return true
      } else {
        // No focused pane: close active group and focus adjacent group
        const activeGroup = groups.find(g => g.id === activeGroupId)
        if (!activeGroup || activeGroup.isMain) return false
        await closeGroupAndFocusAdjacent(activeGroupId)
        return true
      }
    }
  }), [taskId, tabs, groups, closeTab, closeGroupAndFocusAdjacent, activeGroupId, setTabDisplayMode])

  // Build pane props for the active group
  const paneProps = useMemo(() => {
    if (!activeGroup) return []
    return activeGroup.tabs.map(tab => {
      const canClose = !tab.isMain
      return {
        tab,
        taskId,
        sessionId: getSessionId(tab.id),
        cwd,
        conversationId: tab.isMain ? conversationId : undefined,
        existingConversationId: tab.isMain ? existingConversationId : undefined,
        supportsSessionId: tab.isMain ? supportsSessionId : undefined,
        initialPrompt: tab.isMain ? initialPrompt : undefined,
        providerFlags: tab.isMain ? providerFlags : undefined,
        executionContext,
        onConversationCreated: tab.isMain ? handleConversationCreated : undefined,
        onSessionInvalid: tab.isMain ? onSessionInvalid : undefined,
        onReady: tab.isMain ? handleTerminalReady : undefined,
        onFirstInput: tab.isMain ? onFirstInput : undefined,
        onRetry: tab.isMain ? onRetry : undefined,
        // Context menu callbacks
        onSplit: () => handleSplitGroup(activeGroup.id),
        onNewGroup: () => { pendingFocusRef.current = true; createTab() },
        onClose: canClose ? () => {
          if (activeGroup.tabs.length === 1) {
            void closeGroup(activeGroup.id)
          } else {
            void closeTab(tab.id)
          }
        } : null,
        onRename: tab.isMain ? null : () => tabBarRef.current?.startRename(tab.id),
        onResetSession: tab.isMain && onMainReset ? onMainReset : null,
        onSetDisplayMode: (target: import('../shared/types').TabDisplayMode) =>
          setTabDisplayMode(tab.id, target)
      }
    })
  }, [activeGroup, getSessionId, cwd, taskId, conversationId, existingConversationId, supportsSessionId, initialPrompt, providerFlags, executionContext, handleConversationCreated, onSessionInvalid, handleTerminalReady, onFirstInput, onRetry, handleSplitGroup, createTab, closeGroup, closeTab, onMainReset, setTabDisplayMode])

  const showingSubtaskPty = managerMode && managerSelectedTask && managerSelectedTask.id !== taskId
  const subtaskCwd = managerSelectedTask?.worktree_path ?? managerSelectedTask?.base_dir ?? cwd

  return (
    <div className="h-full flex" style={terminalPanelStyle as React.CSSProperties | undefined}>
      {agentManagerEnabled && managerMode && (
        <ManagerSidebar
          rootTaskId={taskId}
          rootTitle={taskTitle ?? 'Main'}
          rootStatus={taskStatus}
          rootProgress={taskProgress}
          selectedTaskId={managerSelectedTask?.id ?? null}
          onSelect={handleManagerSelect}
          onToggleOff={handleManagerToggle}
          onResizingChange={setIsManagerResizing}
        />
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <TerminalTabBar
          ref={tabBarRef}
          groups={groups}
          activeGroupId={activeGroupId}
          terminalTitles={terminalTitles}
          onGroupSelect={(groupId) => { pendingFocusRef.current = true; setActiveGroupId(groupId) }}
          onGroupCreate={() => { pendingFocusRef.current = true; createTab() }}
          onGroupClose={closeGroup}
          onGroupSplit={handleSplitGroup}
          onPaneClose={closeTab}
          onPaneMove={movePane}
          onGroupRename={renameTab}
          rightContent={rightContent}
          managerModeActive={agentManagerEnabled && managerMode}
          onManagerToggle={agentManagerEnabled && hasSubtasks ? handleManagerToggle : undefined}
        />
        <div className="flex-1 min-h-0 relative">
          {isManagerResizing ? (
            <div className="h-full bg-black" />
          ) : showingSubtaskPty && managerSelectedTask ? (
            <TerminalView
              key={`manager:${managerSelectedTask.id}`}
              sessionId={`${managerSelectedTask.id}:${managerSelectedTask.id}`}
              cwd={subtaskCwd}
              mode={managerSelectedTask.terminal_mode}
              isActive={isActive}
              onOpenUrl={onOpenUrl}
              onOpenFile={onOpenFile}
            />
          ) : (
            <TerminalSplitGroup
              ref={splitGroupRef}
              key={activeGroupId}
              panes={paneProps}
              isActive={isActive}
              onAttached={handlePaneAttached}
              onOpenUrl={onOpenUrl}
              onOpenFile={onOpenFile}
            />
          )}
          {overlay}
        </div>
      </div>
    </div>
  )
})
