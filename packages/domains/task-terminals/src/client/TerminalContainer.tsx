import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  forwardRef,
  useImperativeHandle
} from 'react'
import { useTRPCClient } from './trpc'
import { markSkipCache, usePty } from '@slayzone/terminal'
import {
  chatCapabilitiesForMode,
  isPromptCaptureMode,
  type AgentId
} from '@slayzone/terminal-contracts'
import {
  matchesShortcut,
  useShortcutStore,
  withModalGuard,
  getThemeChrome,
  getChromeStyleOverrides,
  useStableCallback
} from '@slayzone/ui'
import { useTheme } from '@slayzone/ui'
import type { TerminalTab } from '../shared/types'
import { isChatSupported } from '../shared/chat-modes'
import { getTabLabel } from './get-tab-label'
import { useTaskTerminals } from './useTaskTerminals'
import { TerminalTabBar, type TerminalTabBarHandle } from './TerminalTabBar'
import { TerminalSplitGroup, type TerminalSplitGroupHandle } from './TerminalSplitGroup'
import { createContainerFocusHandoff } from './focus-handoff'
import {
  AgentPromptsSidebar,
  AgentPromptsToggleButton,
  usePromptsSidebarOpen
} from './agent-prompts/AgentPromptsSidebar'
import {
  SessionsSidebar,
  SessionHistoryToggleButton,
  useSessionsSidebarOpen
} from './agent-sessions/SessionsSidebar'
import { useFamilySessions } from './agent-sessions/useFamilySessions'

export interface TerminalContainerHandle {
  closeActiveGroup: () => Promise<boolean>
}

interface TerminalContainerProps {
  taskId: string
  cwd: string
  defaultMode: AgentId
  conversationId?: string | null
  existingConversationId?: string | null
  supportsSessionId?: boolean
  providerFlags?: string
  executionContext?: import('@slayzone/terminal-contracts').ExecutionContext | null
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
  onOpenArtifact?: (artifactId: string) => void
  onMainReset?: () => void
  /**
   * The main agent's conversation moves to its chat ↔ terminal partner
   * ("Continue in chat" / "Continue in terminal"); absent: no partner.
   */
  onMainHandoff?: () => void
  /** Sessions sidebar: restart the main agent on an earlier session. */
  /** `mode`: the mode that ran it — the other one of the hand-off pair means a hand-off. */
  onSwitchSession?: (conversationId: string, mode: string) => Promise<void>
  /** Sessions sidebar: remove a session from the task. */
  onDeleteSession?: (conversationId: string, mode: string) => Promise<void>
  /**
   * A SECONDARY agent tab's session reset (sessions are per terminal tab). The
   * container stops that tab's agent first and remounts its pane after.
   */
  onTabSessionReset?: (tabId: string, mode: string) => Promise<void>
  /**
   * A secondary agent tab picks a session from the sidebar (`fromMode` ran it;
   * another tab's session moves here). Throws when another tab's live agent runs
   * it. The container then stops and remounts the pane on it.
   */
  onTabSessionSwitch?: (
    tabId: string,
    mode: string,
    conversationId: string,
    fromMode: string
  ) => Promise<void>
  rightContent?: React.ReactNode
  mainTabAccessories?: React.ReactNode
  mainTabContextMenu?: React.ReactNode
  overlay?: React.ReactNode
}

/** A non-main tab running a terminal agent (not a plain shell, not a chat). Its
 *  session is its own (sessions are per tab). */
function isSecondaryAgentTab(tab: TerminalTab): boolean {
  return !tab.isMain && tab.mode !== 'terminal' && !isChatSupported(tab.mode)
}

export const TerminalContainer = forwardRef<TerminalContainerHandle, TerminalContainerProps>(
  function TerminalContainer(
    {
      taskId,
      cwd,
      defaultMode,
      conversationId,
      existingConversationId,
      supportsSessionId,
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
      onOpenArtifact,
      onMainReset,
      onMainHandoff,
      onSwitchSession,
      onDeleteSession,
      onTabSessionReset,
      onTabSessionSwitch,
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
    // Focus attempts no-op silently (pane unmounted, lazy chunk loading, or the
    // tab view still inert during the deferred swap). The handoff verifies each
    // attempt landed inside this container and keeps the claim alive for
    // whichever side (activation / pane attach) can complete it.
    const [focusHandoff] = useState(() => createContainerFocusHandoff(isActive))
    // Plain closures over the handoff's own state — safe to call detached.
    const {
      claim: claimFocus,
      activate: activateFocus,
      paneAttached: focusPaneAttached,
      setContainer: setFocusContainer
    } = focusHandoff
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

    // Session history: lists every agent session (distinct provider conversation)
    // tied to the MAIN agent. Same gate as the prompts sidebar (main group active,
    // capture-capable terminal agent). Show the toggle for multiple sessions or
    // one previous session after Reset (when none is current). Query only runs
    // while that gate holds, so idle tasks pay nothing.
    // The Sessions list also serves Claude chat (its resume picker), listing the
    // chat's and the terminal's conversations together (one CLI session store).
    //
    // Sessions are per terminal tab (v201): a secondary agent tab gets its own list
    // (every tab's sessions, labelled; a pick moves one here) and its own Reset.
    const sessionsTab: TerminalTab | null =
      (activeGroup?.isMain
        ? activeGroup.tabs.find((t) => t.isMain)
        : activeGroup?.tabs.find(isSecondaryAgentTab)) ?? null
    const sessionsMode = sessionsTab?.mode
    const sessionsEnabled =
      !!sessionsTab &&
      !!sessionsMode &&
      (sessionsTab.isMain
        ? isPromptCaptureMode(sessionsMode) || chatCapabilitiesForMode(sessionsMode).sessions
        : isPromptCaptureMode(sessionsMode) && !!onTabSessionSwitch)
    const sessions = useFamilySessions(taskId, sessionsMode ?? '', sessionsEnabled, sessionsTab?.id)
    const canShowSessions =
      sessionsEnabled && (sessions.length > 1 || (sessions.length === 1 && !sessions[0].isCurrent))
    const [sessionsOpen, toggleSessions] = useSessionsSidebarOpen(taskId)
    // The chat palette's "Sessions…": opens the sidebar (never closes it).
    const openSessions = useCallback(() => {
      if (!sessionsOpen) toggleSessions()
    }, [sessionsOpen, toggleSessions])
    const showSessions = canShowSessions ? openSessions : null

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
          claimFocus(true)
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
              if (newTab) claimFocus(getSessionId(newTab.id))
            })
          }
        }
      })

      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }, [shortcutActive, activeGroup, createTab, splitTab, getSessionId, claimFocus])

    // Split the active group — add a new pane
    const handleSplitGroup = useCallback(
      (groupId: string) => {
        const group = groups.find((g) => g.id === groupId)
        if (!group) return
        const lastPane = group.tabs[group.tabs.length - 1]
        if (lastPane) {
          splitTab(lastPane.id).then((newTab) => {
            if (newTab) claimFocus(getSessionId(newTab.id))
          })
        }
      },
      [groups, splitTab, getSessionId, claimFocus]
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
        claimFocus(true)
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
      onFocusRequestHandled,
      claimFocus
    ])

    useEffect(() => {
      tryApplyFocusRequest()
    }, [tryApplyFocusRequest])

    // Focus terminal when task becomes the shortcut-focused cell (or active in non-explode)
    useEffect(() => {
      if (!shortcutActive) return
      activateFocus(() => splitGroupRef.current?.focus())
    }, [shortcutActive, activateFocus])

    const handlePaneAttached = useCallback(
      (api: { sessionId: string; focus: () => void }) => {
        focusPaneAttached(api)
      },
      [focusPaneAttached]
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
          claimFocus(true)
          setActiveGroupId(adjacentGroup.id)
        }
      },
      [groups, closeGroup, setActiveGroupId, claimFocus]
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
      [taskId, groups, closeTab, closeGroupAndFocusAdjacent, activeGroupId]
    )

    const startTabRename = useCallback((tabId: string) => {
      tabBarRef.current?.startRename(tabId)
    }, [])

    // A secondary pane remounts (re-resolving ITS session) after a reset/switch.
    const [paneEpochs, setPaneEpochs] = useState<Readonly<Record<string, number>>>({})
    const remountPane = useCallback((tabId: string) => {
      setPaneEpochs((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }))
    }, [])
    // Reset a secondary agent tab: stop its agent, reset ITS session (no other
    // tab's), remount — the respawn starts fresh.
    const resetTabSession = useStableCallback(async (tab: TerminalTab) => {
      if (!onTabSessionReset) return
      const sid = getSessionId(tab.id)
      await trpcClient.pty.kill.mutate({ sessionId: sid })
      await onTabSessionReset(tab.id, tab.mode)
      await new Promise((r) => setTimeout(r, 100))
      markSkipCache(sid)
      remountPane(tab.id)
    })
    // Pick a session in a secondary tab: the server moves it here first (and
    // refuses, naming the tab, if another tab's agent runs it — nothing stopped
    // then), then this tab's agent restarts on it.
    const switchTabSession = useStableCallback(
      async (tab: TerminalTab, conversationId: string, fromMode: string) => {
        if (!onTabSessionSwitch) return
        await onTabSessionSwitch(tab.id, tab.mode, conversationId, fromMode)
        const sid = getSessionId(tab.id)
        await trpcClient.pty.kill.mutate({ sessionId: sid })
        await new Promise((r) => setTimeout(r, 100))
        markSkipCache(sid)
        remountPane(tab.id)
      }
    )
    const tabName = useCallback(
      (tabId: string): string => {
        const tab = tabs.find((t) => t.id === tabId)
        if (!tab) return tabId === taskId ? 'Main' : 'A closed'
        return tab.isMain ? 'Main' : getTabLabel(tab, terminalTitles.get(tab.id))
      },
      [tabs, taskId, terminalTitles]
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
          supportsSessionId: tab.isMain ? supportsSessionId : undefined,
          providerFlags: tab.isMain ? providerFlags : undefined,
          executionContext,
          isTemporary,
          onStartFresh: tab.isMain
            ? onStartFresh
            : isSecondaryAgentTab(tab) && onTabSessionReset
              ? () => void resetTabSession(tab)
              : undefined,
          remountKey: paneEpochs[tab.id] ?? 0,
          onReady: tab.isMain ? handleTerminalReady : undefined,
          onFirstInput: tab.isMain ? onFirstInput : undefined,
          onRetry: tab.isMain ? onRetry : undefined,
          // Context menu callbacks
          onSplit: () => handleSplitGroup(activeGroup.id),
          onNewGroup: () => {
            claimFocus(true)
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
          onRename: tab.isMain ? null : () => startTabRename(tab.id),
          onResetSession: tab.isMain
            ? (onMainReset ?? null)
            : isSecondaryAgentTab(tab) && onTabSessionReset
              ? () => void resetTabSession(tab)
              : null,
          onHandoff: tab.isMain && onMainHandoff ? onMainHandoff : null,
          onShowSessions: showSessions
        }
      })
    }, [
      activeGroup,
      getSessionId,
      cwd,
      taskId,
      conversationId,
      existingConversationId,
      supportsSessionId,
      providerFlags,
      executionContext,
      isTemporary,
      onStartFresh,
      handleTerminalReady,
      onFirstInput,
      onRetry,
      onTabSessionReset,
      resetTabSession,
      paneEpochs,
      handleSplitGroup,
      createTab,
      closeGroup,
      closeTab,
      onMainReset,
      onMainHandoff,
      claimFocus,
      startTabRename,
      showSessions
    ])

    return (
      <div
        ref={setFocusContainer}
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
              claimFocus(true)
              setActiveGroupId(groupId)
            }}
            onGroupCreate={() => {
              claimFocus(true)
              createTab()
            }}
            onGroupClose={closeGroup}
            onGroupSplit={handleSplitGroup}
            onPaneClose={closeTab}
            onPaneMove={movePane}
            onGroupRename={renameTab}
            rightContent={
              canShowSessions || (canShowPrompts && !promptsOpen) ? (
                <div className="flex items-center gap-2">
                  {canShowSessions && (
                    <SessionHistoryToggleButton onToggle={toggleSessions} open={sessionsOpen} />
                  )}
                  {canShowPrompts && !promptsOpen && (
                    <AgentPromptsToggleButton onToggle={togglePrompts} />
                  )}
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
              onOpenArtifact={onOpenArtifact}
            />
            {overlay}
          </div>
        </div>
        {canShowSessions && sessionsOpen && sessionsTab && sessionsMode && (
          <SessionsSidebar
            key={sessionsTab.id}
            taskId={taskId}
            agentId={sessionsMode}
            tabId={sessionsTab.id}
            tabName={tabName}
            onToggle={toggleSessions}
            onSwitch={
              sessionsTab.isMain
                ? onSwitchSession
                : (conversationId, fromMode) =>
                    switchTabSession(sessionsTab, conversationId, fromMode)
            }
            onDelete={onDeleteSession}
          />
        )}
        {canShowPrompts && promptsOpen && mainMode && (
          <AgentPromptsSidebar taskId={taskId} agentId={mainMode} onToggle={togglePrompts} />
        )}
      </div>
    )
  }
)
