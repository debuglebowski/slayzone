import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  forwardRef,
  useImperativeHandle
} from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { usePty } from '@slayzone/terminal'
import { isPromptCaptureMode, type TerminalMode } from '@slayzone/terminal/shared'
import {
  matchesShortcut,
  useShortcutStore,
  withModalGuard,
  getThemeChrome,
  getChromeStyleOverrides
} from '@slayzone/ui'
import { useTheme } from '@slayzone/settings/client'
import { useTaskTerminals } from './useTaskTerminals'
import { TerminalTabBar, type TerminalTabBarHandle } from './TerminalTabBar'
import { TerminalSplitGroup, type TerminalSplitGroupHandle } from './TerminalSplitGroup'
import { createFocusHandoff, type FocusHandoff } from './focus-handoff'
import {
  AgentPromptsSidebar,
  AgentPromptsToggleButton,
  usePromptsSidebarOpen
} from './agent-prompts/AgentPromptsSidebar'

export interface TerminalContainerHandle {
  closeActiveGroup: () => Promise<boolean>
}

interface TerminalContainerProps {
  taskId: string
  cwd: string
  defaultMode: TerminalMode
  conversationId?: string | null
  existingConversationId?: string | null
  /** True once the task's conversation id is hydrated (currentConversationByMode
   *  set by parseAndColorTasks). When explicitly false, the main tab holds
   *  auto-spawn until hydration so it never spawns with a null hint. Undefined =
   *  no gate (preserves behavior for non-gated callers). */
  conversationHydrated?: boolean
  supportsSessionId?: boolean
  initialPrompt?: string | null
  providerFlags?: string
  executionContext?: import('@slayzone/terminal/shared').ExecutionContext | null
  /** Owning task is temporary — disables terminal auto-start (regular-task-only). */
  isTemporary?: boolean
  isActive?: boolean
  /** Panel is mid-resize — keep the terminal mounted but pause xterm re-fit. */
  paused?: boolean
  /** Owns keyboard shortcuts (Cmd+D, Cmd+T). Defaults to `isActive`. In explode mode, only the focused cell has this true. */
  hasShortcutFocus?: boolean
  focusRequestId?: number
  onStartFresh?: () => void
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
  onOpenUrl?: (url: string) => void
  onOpenFile?: (filePath: string, options?: { position?: { line: number; col?: number } }) => void
  onMainReset?: () => void
  rightContent?: React.ReactNode
  mainTabAccessories?: React.ReactNode
  mainTabContextMenu?: React.ReactNode
  overlay?: React.ReactNode
}

export const TerminalContainer = forwardRef<TerminalContainerHandle, TerminalContainerProps>(
  function TerminalContainer(
    {
      taskId,
      cwd,
      defaultMode,
      conversationId,
      existingConversationId,
      conversationHydrated,
      supportsSessionId,
      initialPrompt,
      providerFlags,
      executionContext,
      isTemporary,
      isActive = true,
      paused = false,
      hasShortcutFocus,
      focusRequestId = 0,
      onStartFresh,
      onReady,
      onFirstInput,
      onRetry,
      onFocusRequestHandled,
      onMainTabActiveChange,
      onOpenUrl,
      onOpenFile,
      onMainReset,
      rightContent,
      mainTabAccessories,
      mainTabContextMenu,
      overlay
    }: TerminalContainerProps,
    ref
  ) {
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
      getSessionId
    } = useTaskTerminals(taskId, defaultMode)

    // Owns keyboard shortcuts; falls back to isActive so non-explode callers need not set it.
    const shortcutActive = hasShortcutFocus ?? isActive

    // Vanilla client (stable ref) — claimSession is fire-and-forget. Using
    // useMutation here returns a NEW object each render; putting it in the
    // claim effect's deps caused an infinite mutate→render→mutate loop.
    const trpcClient = useTRPCClient()
    const { subscribePrompt, subscribeTitle } = usePty()
    const { terminalOverrideThemeId, contentVariant } = useTheme()
    const terminalPanelStyle = useMemo(() => {
      if (!terminalOverrideThemeId) return undefined
      return getChromeStyleOverrides(getThemeChrome(terminalOverrideThemeId, contentVariant))
    }, [terminalOverrideThemeId, contentVariant])
    const splitGroupRef = useRef<TerminalSplitGroupHandle | null>(null)
    const tabBarRef = useRef<TerminalTabBarHandle | null>(null)
    const rootElRef = useRef<HTMLDivElement | null>(null)
    // Focus attempts no-op silently (pane unmounted, lazy chunk loading, or the
    // tab view still inert during the deferred swap). The handoff verifies each
    // attempt landed — container-contains is the right granularity since panes
    // are opaque (xterm textarea vs chat input) — and keeps the claim alive for
    // whichever side (activation / pane attach) can complete it.
    const focusHandoffRef = useRef<FocusHandoff | null>(null)
    if (!focusHandoffRef.current) {
      focusHandoffRef.current = createFocusHandoff(
        () => !!rootElRef.current?.contains(document.activeElement),
        isActive
      )
    }
    const focusHandoff = focusHandoffRef.current
    const terminalApiRef = useRef<{
      sendInput: (text: string) => Promise<void>
      write: (data: string) => Promise<boolean>
      focus: () => void
      clearBuffer: () => Promise<void>
    } | null>(null)
    const lastHandledFocusRequestRef = useRef(0)

    // Get active group
    const activeGroup = groups.find((g) => g.id === activeGroupId)
    const mainGroupId = groups.find((group) => group.tabs.some((tab) => tab.isMain))?.id ?? null

    // Agent-prompts sidebar: lists user messages sent to the MAIN agent. Only
    // for terminal (non-chat) agents whose prompts we can capture cleanly, and
    // only while the main group is active (it's main-agent contextual).
    const mainMode = tabs.find((t) => t.isMain)?.mode
    const canShowPrompts =
      (activeGroup?.isMain ?? false) && !!mainMode && isPromptCaptureMode(mainMode)
    const [promptsOpen, togglePrompts] = usePromptsSidebarOpen(taskId)

    // Notify parent when main tab active state changes
    useEffect(() => {
      onMainTabActiveChange?.(activeGroup?.isMain ?? false)
    }, [activeGroup?.isMain, onMainTabActiveChange])

    // Forward main tab state changes to task-level callbacks
    useEffect(() => {
      const mainTab = tabs.find((t) => t.isMain)
      if (!mainTab) return
      const mainSessionId = getSessionId(mainTab.id)
      return subscribePrompt(mainSessionId, () => {
        // Main tab prompt events could trigger task-level UI updates
      })
    }, [taskId, tabs, getSessionId, subscribePrompt])

    // Multi-window: claim all task sessions for THIS window on mount + on focus.
    // PTY output reroutes to the window currently rendering the terminal panel.
    useEffect(() => {
      const claimAll = () => {
        for (const tab of tabs) {
          const sid = getSessionId(tab.id)
          if (sid) void trpcClient.app.taskWindows.claimSession.mutate({ sessionId: sid })
        }
      }
      claimAll()
      window.addEventListener('focus', claimAll)
      return () => window.removeEventListener('focus', claimAll)
    }, [tabs, getSessionId, trpcClient])

    // Track terminal process titles for tab labels
    const [terminalTitles, setTerminalTitles] = useState<Map<string, string>>(new Map())
    useEffect(() => {
      const unsubs: Array<() => void> = []
      for (const tab of tabs) {
        if (tab.isMain) continue
        const sessionId = getSessionId(tab.id)
        const unsub = subscribeTitle(sessionId, (title) => {
          setTerminalTitles((prev) => {
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
      return () => unsubs.forEach((u) => u())
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
          focusHandoff.claim(true)
          createTab()
        }
        // Split current group
        if (
          matchesShortcut(e, useShortcutStore.getState().getKeys('terminal-split')) &&
          activeGroup
        ) {
          e.preventDefault()
          const lastPane = activeGroup.tabs[activeGroup.tabs.length - 1]
          if (lastPane) {
            splitTab(lastPane.id).then((newTab) => {
              if (newTab) focusHandoff.claim(getSessionId(newTab.id))
            })
          }
        }
      })

      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }, [shortcutActive, activeGroup, createTab, splitTab, getSessionId, focusHandoff])

    // Split the active group — add a new pane
    const handleSplitGroup = useCallback(
      (groupId: string) => {
        const group = groups.find((g) => g.id === groupId)
        if (!group) return
        const lastPane = group.tabs[group.tabs.length - 1]
        if (lastPane) {
          splitTab(lastPane.id).then((newTab) => {
            if (newTab) focusHandoff.claim(getSessionId(newTab.id))
          })
        }
      },
      [groups, splitTab, getSessionId, focusHandoff]
    )

    // Close an entire group (all its panes)
    const closeGroup = useCallback(
      async (groupId: string) => {
        const group = groups.find((g) => g.id === groupId)
        if (!group || group.isMain) return
        for (const tab of [...group.tabs].reverse()) {
          await closeTab(tab.id)
        }
      },
      [groups, closeTab]
    )

    const tryApplyFocusRequest = useCallback(() => {
      if (focusRequestId <= 0 || focusRequestId <= lastHandledFocusRequestRef.current) return
      if (!isActive || !terminalApiRef.current) return

      if (mainGroupId && activeGroupId !== mainGroupId) {
        focusHandoff.claim(true)
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
      focusHandoff.activate(() => splitGroupRef.current?.focus())
    }, [shortcutActive, focusHandoff])

    const handlePaneAttached = useCallback(
      (api: { sessionId: string; focus: () => void }) => {
        focusHandoff.paneAttached(api)
      },
      [focusHandoff]
    )

    // Handle terminal ready - pass up to parent (main tab's API)
    const handleTerminalReady = useCallback(
      (api: {
        sendInput: (text: string) => Promise<void>
        write: (data: string) => Promise<boolean>
        focus: () => void
        clearBuffer: () => Promise<void>
      }) => {
        terminalApiRef.current = api
        onReady?.(api)
        tryApplyFocusRequest()
      },
      [onReady, tryApplyFocusRequest]
    )

    // Close a group and focus the adjacent group's terminal
    const closeGroupAndFocusAdjacent = useCallback(
      async (groupId: string) => {
        const groupIndex = groups.findIndex((g) => g.id === groupId)
        if (groupIndex === -1 || groups[groupIndex]?.isMain) return
        const adjacentGroup = groups[groupIndex > 0 ? groupIndex - 1 : 1]
        await closeGroup(groupId)
        if (adjacentGroup) {
          focusHandoff.claim(true)
          setActiveGroupId(adjacentGroup.id)
        }
      },
      [groups, closeGroup, setActiveGroupId, focusHandoff]
    )

    useImperativeHandle(
      ref,
      () => ({
        closeActiveGroup: async (): Promise<boolean> => {
          const active = document.activeElement as HTMLElement | null
          const paneEl = active?.closest('[data-session-id]')
          const sessionId = paneEl?.getAttribute('data-session-id')

          if (sessionId) {
            const tabId = sessionId.substring(taskId.length + 1)
            const group = groups.find((g) => g.tabs.some((t) => t.id === tabId))
            if (!group) return false
            if (group.isMain && group.tabs.length === 1) return false

            if (group.tabs.length > 1) {
              // Multiple panes: close focused pane, focus adjacent pane in same group
              const paneIndex = group.tabs.findIndex((t) => t.id === tabId)
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
            const activeGroup = groups.find((g) => g.id === activeGroupId)
            if (!activeGroup || activeGroup.isMain) return false
            await closeGroupAndFocusAdjacent(activeGroupId)
            return true
          }
        }
      }),
      [taskId, tabs, groups, closeTab, closeGroupAndFocusAdjacent, activeGroupId]
    )

    // Build pane props for the active group
    const paneProps = useMemo(() => {
      if (!activeGroup) return []
      return activeGroup.tabs.map((tab) => {
        const canClose = !tab.isMain
        return {
          tab,
          taskId,
          sessionId: getSessionId(tab.id),
          cwd,
          conversationId: tab.isMain ? conversationId : undefined,
          existingConversationId: tab.isMain ? existingConversationId : undefined,
          // Gate only the main tab; splits/extra panes spawn fresh by design.
          conversationHydrated: tab.isMain ? conversationHydrated : true,
          supportsSessionId: tab.isMain ? supportsSessionId : undefined,
          initialPrompt: tab.isMain ? initialPrompt : undefined,
          providerFlags: tab.isMain ? providerFlags : undefined,
          executionContext,
          isTemporary,
          onStartFresh: tab.isMain ? onStartFresh : undefined,
          onReady: tab.isMain ? handleTerminalReady : undefined,
          onFirstInput: tab.isMain ? onFirstInput : undefined,
          onRetry: tab.isMain ? onRetry : undefined,
          // Context menu callbacks
          onSplit: () => handleSplitGroup(activeGroup.id),
          onNewGroup: () => {
            focusHandoff.claim(true)
            createTab()
          },
          onClose: canClose
            ? () => {
                if (activeGroup.tabs.length === 1) {
                  void closeGroup(activeGroup.id)
                } else {
                  void closeTab(tab.id)
                }
              }
            : null,
          onRename: tab.isMain ? null : () => tabBarRef.current?.startRename(tab.id),
          onResetSession: tab.isMain && onMainReset ? onMainReset : null
        }
      })
    }, [
      activeGroup,
      getSessionId,
      cwd,
      taskId,
      conversationId,
      existingConversationId,
      conversationHydrated,
      supportsSessionId,
      initialPrompt,
      providerFlags,
      executionContext,
      isTemporary,
      onStartFresh,
      handleTerminalReady,
      onFirstInput,
      onRetry,
      handleSplitGroup,
      createTab,
      closeGroup,
      closeTab,
      onMainReset
    ])

    return (
      <div
        ref={rootElRef}
        className="h-full flex"
        style={terminalPanelStyle as React.CSSProperties | undefined}
      >
        <div className="flex-1 min-w-0 flex flex-col">
          <TerminalTabBar
            ref={tabBarRef}
            groups={groups}
            activeGroupId={activeGroupId}
            terminalTitles={terminalTitles}
            onGroupSelect={(groupId) => {
              focusHandoff.claim(true)
              setActiveGroupId(groupId)
            }}
            onGroupCreate={() => {
              focusHandoff.claim(true)
              createTab()
            }}
            onGroupClose={closeGroup}
            onGroupSplit={handleSplitGroup}
            onPaneClose={closeTab}
            onPaneMove={movePane}
            onGroupRename={renameTab}
            rightContent={
              canShowPrompts && !promptsOpen ? (
                <div className="flex items-center gap-2">
                  <AgentPromptsToggleButton onToggle={togglePrompts} />
                  {rightContent}
                </div>
              ) : (
                rightContent
              )
            }
            mainTabAccessories={mainTabAccessories}
            mainTabContextMenu={mainTabContextMenu}
          />
          <div className="flex-1 min-h-0 relative">
            <TerminalSplitGroup
              ref={splitGroupRef}
              key={activeGroupId}
              panes={paneProps}
              isActive={isActive}
              paused={paused}
              onAttached={handlePaneAttached}
              onOpenUrl={onOpenUrl}
              onOpenFile={onOpenFile}
            />
            {overlay}
          </div>
        </div>
        {canShowPrompts && promptsOpen && mainMode && (
          <AgentPromptsSidebar taskId={taskId} agentId={mainMode} onToggle={togglePrompts} />
        )}
      </div>
    )
  }
)
