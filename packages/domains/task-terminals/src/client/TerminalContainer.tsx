import { useEffect, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from 'react'
import { usePty } from '@slayzone/terminal'
import type { TerminalMode, CodeMode } from '@slayzone/terminal/shared'
import { useTaskTerminals } from './useTaskTerminals'
import { TerminalTabBar } from './TerminalTabBar'
import { TerminalSplitGroup } from './TerminalSplitGroup'

export interface TerminalContainerHandle {
  closeActiveGroup: () => Promise<boolean>
}

interface TerminalContainerProps {
  taskId: string
  cwd: string
  defaultMode: TerminalMode
  conversationId?: string | null
  existingConversationId?: string | null
  initialPrompt?: string | null
  codeMode?: CodeMode | null
  providerFlags?: string
  isActive?: boolean
  autoFocus?: boolean
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
  onMainTabActiveChange?: (isMainActive: boolean) => void
  rightContent?: React.ReactNode
}

export const TerminalContainer = forwardRef<TerminalContainerHandle, TerminalContainerProps>(function TerminalContainer({
  taskId,
  cwd,
  defaultMode,
  conversationId,
  existingConversationId,
  initialPrompt,
  codeMode,
  providerFlags,
  isActive = true,
  autoFocus = false,
  onConversationCreated,
  onSessionInvalid,
  onReady,
  onFirstInput,
  onRetry,
  onMainTabActiveChange,
  rightContent
}: TerminalContainerProps, ref) {
  const {
    tabs,
    groups,
    activeGroupId,
    isLoading,
    setActiveGroupId,
    createTab,
    splitTab,
    closeTab,
    movePane,
    renameTab,
    getSessionId
  } = useTaskTerminals(taskId, defaultMode)

  const { subscribePrompt } = usePty()
  const terminalApiRef = useRef<{
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  } | null>(null)

  // Get active group
  const activeGroup = groups.find(g => g.id === activeGroupId)

  // Notify parent when main tab active state changes
  useEffect(() => {
    onMainTabActiveChange?.(activeGroup?.isMain ?? false)
  }, [activeGroup?.isMain, onMainTabActiveChange])

  // Forward main tab state changes to task-level callbacks
  useEffect(() => {
    const mainTab = tabs.find(t => t.isMain)
    if (!mainTab) return
    const mainSessionId = getSessionId(mainTab.id)
    return subscribePrompt(mainSessionId, () => {
      // Main tab prompt events could trigger task-level UI updates
    })
  }, [taskId, tabs, getSessionId, subscribePrompt])

  // Keyboard shortcuts
  useEffect(() => {
    if (!isActive) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+T: New group
      if (e.metaKey && e.key === 't' && !e.shiftKey) {
        e.preventDefault()
        createTab().then(tab => focusGroupTerminal(`${taskId}:${tab.id}`))
      }
      // Cmd+D: Split current group
      if (e.metaKey && e.key === 'd' && !e.shiftKey && activeGroup) {
        e.preventDefault()
        // Split the last pane in the active group
        const lastPane = activeGroup.tabs[activeGroup.tabs.length - 1]
        if (lastPane) splitTab(lastPane.id).then(tab => { if (tab) focusGroupTerminal(`${taskId}:${tab.id}`) })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isActive, activeGroup, createTab, splitTab])

  // Handle terminal ready - pass up to parent (main tab's API)
  const handleTerminalReady = useCallback((api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => {
    terminalApiRef.current = api
    onReady?.(api)
  }, [onReady])

  // Handle conversation created - only for main tab
  const handleConversationCreated = useCallback((convId: string) => {
    onConversationCreated?.(convId)
  }, [onConversationCreated])

  // Split the active group — add a new pane
  const handleSplitGroup = useCallback((groupId: string) => {
    const group = groups.find(g => g.id === groupId)
    if (!group) return
    const lastPane = group.tabs[group.tabs.length - 1]
    if (lastPane) splitTab(lastPane.id)
  }, [groups, splitTab])

  // Close an entire group (all its panes)
  const closeGroup = useCallback(async (groupId: string) => {
    const group = groups.find(g => g.id === groupId)
    if (!group || group.isMain) return
    for (const tab of [...group.tabs].reverse()) {
      await closeTab(tab.id)
    }
  }, [groups, closeTab])

  // Focus the xterm textarea for a given session ID.
  // If the element isn't in the DOM yet (new terminal initializing), wait via MutationObserver.
  const focusGroupTerminal = useCallback((sessionId: string) => {
    const selector = `[data-session-id="${sessionId}"] .xterm-helper-textarea`
    const tryNow = () => {
      const el = document.querySelector<HTMLElement>(selector)
      if (el) { el.focus(); return true }
      return false
    }
    if (tryNow()) return
    // Element not yet in DOM — wait for it
    const observer = new MutationObserver(() => {
      if (tryNow()) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => observer.disconnect(), 3000)
  }, [])

  // Close a group and focus the adjacent group's terminal
  const closeGroupAndFocusAdjacent = useCallback(async (groupId: string) => {
    const groupIndex = groups.findIndex(g => g.id === groupId)
    if (groupIndex === -1 || groups[groupIndex]?.isMain) return
    const adjacentGroup = groups[groupIndex > 0 ? groupIndex - 1 : 1]
    await closeGroup(groupId)
    if (adjacentGroup) {
      setActiveGroupId(adjacentGroup.id)
      focusGroupTerminal(`${taskId}:${adjacentGroup.tabs[0].id}`)
    }
  }, [groups, closeGroup, setActiveGroupId, taskId, focusGroupTerminal])

  useImperativeHandle(ref, () => ({
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
          if (adjacentTab) focusGroupTerminal(`${taskId}:${adjacentTab.id}`)
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
  }), [taskId, groups, closeTab, closeGroupAndFocusAdjacent, focusGroupTerminal, activeGroupId])

  // Build pane props for the active group
  const paneProps = useMemo(() => {
    if (!activeGroup) return []
    return activeGroup.tabs.map(tab => ({
      tab,
      sessionId: getSessionId(tab.id),
      cwd,
      conversationId: tab.isMain ? conversationId : undefined,
      existingConversationId: tab.isMain ? existingConversationId : undefined,
      initialPrompt: tab.isMain ? initialPrompt : undefined,
      codeMode: tab.isMain ? codeMode : undefined,
      providerFlags: tab.isMain ? providerFlags : undefined,
      autoFocus,
      onConversationCreated: tab.isMain ? handleConversationCreated : undefined,
      onSessionInvalid: tab.isMain ? onSessionInvalid : undefined,
      onReady: tab.isMain ? handleTerminalReady : undefined,
      onFirstInput: tab.isMain ? onFirstInput : undefined,
      onRetry: tab.isMain ? onRetry : undefined
    }))
  }, [activeGroup, getSessionId, cwd, conversationId, existingConversationId, initialPrompt, codeMode, providerFlags, autoFocus, handleConversationCreated, onSessionInvalid, handleTerminalReady, onFirstInput, onRetry])

  if (isLoading || !activeGroup) {
    return (
      <div className="h-full flex items-center justify-center bg-terminal-bg">
        <div className="text-neutral-500 text-sm">Loading terminal...</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <TerminalTabBar
        groups={groups}
        activeGroupId={activeGroupId}
        onGroupSelect={setActiveGroupId}
        onGroupCreate={() => createTab().then(tab => focusGroupTerminal(`${taskId}:${tab.id}`))}
        onGroupClose={closeGroup}
        onGroupSplit={handleSplitGroup}
        onPaneClose={closeTab}
        onPaneMove={movePane}
        onGroupRename={renameTab}
        rightContent={rightContent}
      />
      <div className="flex-1 min-h-0">
        <TerminalSplitGroup
          key={activeGroupId}
          panes={paneProps}
        />
      </div>
    </div>
  )
})
