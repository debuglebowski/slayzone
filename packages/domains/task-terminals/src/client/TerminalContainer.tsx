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
  useStableCallback,
  useAppearance
} from '@slayzone/ui'
import { Button, useTheme } from '@slayzone/ui'
import type { TerminalGroup, TerminalTab } from '../shared/types'
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
import { ChatFontSizeControl } from './chat/ChatFontSizeControl'

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
  onOpenTask?: (taskRef: string) => void
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
  /**
   * Which of the task's terminal groups this container shows, when several panels
   * share the task's terminals (docs/plans/panel-model.md step 7): `only` these
   * (another agent/terminal panel), or all `except` these (the primary agent panel,
   * without the groups other panels claim). Absent: every group.
   */
  groupFilter?: { only?: readonly string[]; except?: readonly string[] }
  /** A group was created here (new-group button, ⌘T): the panel claims it. */
  onGroupCreated?: (groupId: string) => void
  /** Shown instead of the "start your own agent" state when this container shows no group. */
  emptyState?: React.ReactNode
}

/** `groups` narrowed by a container's `groupFilter`. */
export function filterTerminalGroups(
  groups: TerminalGroup[],
  filter: TerminalContainerProps['groupFilter']
): TerminalGroup[] {
  if (!filter) return groups
  const { only, except } = filter
  return groups.filter((g) => (!only || only.includes(g.id)) && (!except || !except.includes(g.id)))
}

/** A non-main tab running a terminal agent (not a plain shell, not a chat). Its
 *  session is its own (sessions are per tab). */
function isSecondaryAgentTab(tab: TerminalTab): boolean {
  return !tab.isMain && tab.mode !== 'terminal' && !isChatSupported(tab.mode)
}

/**
 * A tab group not shown: hidden like an inactive task tab (PaneFrame in the
 * app shell) — same box, so xterm sees no resize; inert; transitions killed
 * and animations paused so nothing hidden keeps painting.
 */
const HIDDEN_GROUP_CLASS =
  'absolute inset-0 invisible [&_*]:transition-none! [&_*]:[animation-play-state:paused]!'

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
      onOpenTask,
      onMainReset,
      onMainHandoff,
      onSwitchSession,
      onDeleteSession,
      onTabSessionReset,
      onTabSessionSwitch,
      rightContent,
      mainTabAccessories,
      mainTabContextMenu,
      overlay,
      groupFilter,
      onGroupCreated,
      emptyState
    }: TerminalContainerProps,
    ref
  ) {
    const {
      tabs,
      loadState,
      reload,
      groups: allGroups,
      activeGroupId: requestedGroupId,
      setActiveGroupId,
      createTab: createTaskTab,
      splitTab,
      closeTab,
      movePane,
      renameTab,
      setChatFontSize,
      getSessionId
    } = useTaskTerminals(taskId, defaultMode)
    const { chatFontSize: defaultChatFontSize } = useAppearance()

    // The groups this container shows (several panels may split the task's terminals).
    // Pass a stable `groupFilter`: a new one re-filters (new `groups`) on every render.
    const groups = filterTerminalGroups(allGroups, groupFilter)
    // The active group is one this container shows: its first one while the
    // requested group is another panel's (or not loaded yet).
    const activeGroupId = groups.some((g) => g.id === requestedGroupId)
      ? requestedGroupId
      : (groups[0]?.id ?? requestedGroupId)
    const createTab = useCallback(
      async (mode?: AgentId): Promise<TerminalTab> => {
        const tab = await createTaskTab(mode)
        onGroupCreated?.(tab.groupId)
        return tab
      },
      [createTaskTab, onGroupCreated]
    )

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
    // Groups stay mounted once shown, so switching back to one doesn't remount
    // its panes (a chat re-hydrating, a terminal reattaching). A group mounts on
    // its first visit, so its terminals start when the user opens it, as before.
    const [mountedGroupIds, setMountedGroupIds] = useState<ReadonlySet<string>>(
      () => new Set([activeGroupId])
    )
    if (!mountedGroupIds.has(activeGroupId)) {
      setMountedGroupIds(new Set([...mountedGroupIds, activeGroupId]))
    }
    const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null)
    const [prefetchedGroupId, setPrefetchedGroupId] = useState<string | null>(null)
    const hovered = groups.find((g) => g.id === hoveredGroupId)
    const hoveredTab = hovered?.tabs.length === 1 ? hovered.tabs[0] : undefined
    const prefetchCandidate =
      isActive &&
      hoveredGroupId &&
      !mountedGroupIds.has(hoveredGroupId) &&
      hoveredTab &&
      hoveredTab.agentState !== 'new' &&
      isChatSupported(hoveredTab.mode)
        ? hoveredGroupId
        : null
    useEffect(() => {
      if (!prefetchCandidate) return
      const timer = setTimeout(() => setPrefetchedGroupId(prefetchCandidate), 180)
      return () => clearTimeout(timer)
    }, [prefetchCandidate])
    const mainGroupId = groups.find((group) => group.tabs.some((tab) => tab.isMain))?.id ?? null

    // Chat font size: the header control sizes the active group's chat(s). A group
    // rarely holds two chats; when it does they move together, read from the first.
    const activeChatTabs = activeGroup?.tabs.filter((t) => isChatSupported(t.mode)) ?? []
    const activeChatFontSize = activeChatTabs[0]?.chatFontSize ?? null
    const setActiveChatFontSize = (size: number | null): void => {
      for (const tab of activeChatTabs) void setChatFontSize(tab.id, size)
    }

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

    // Group switch: a revisited group is already mounted, so no pane attaches to
    // complete the switch's focus claim — focus the shown group here. (A group
    // on its first visit isn't attached yet: focus no-ops, the claim stays for
    // its attach.)
    const shownGroupIdRef = useRef(activeGroupId)
    useEffect(() => {
      if (shownGroupIdRef.current === activeGroupId) return
      shownGroupIdRef.current = activeGroupId
      if (shortcutActive) activateFocus(() => splitGroupRef.current?.focus())
    }, [activeGroupId, shortcutActive, activateFocus])

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

    // Pane props per group (every mounted group renders, not just the active one).
    const panesByGroup = useMemo(() => {
      const build = (group: TerminalGroup) =>
        group.tabs.map((tab) => {
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
            onRemount: () => {
              markSkipCache(getSessionId(tab.id))
              remountPane(tab.id)
            },
            // Context menu callbacks
            onSplit: () => handleSplitGroup(group.id),
            onNewGroup: () => {
              claimFocus(true)
              createTab()
            },
            onClose: canClose
              ? () => {
                  if (group.tabs.length === 1) {
                    void closeGroup(group.id)
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
      return new Map(groups.map((group) => [group.id, build(group)]))
    }, [
      groups,
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
      remountPane,
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
            onGroupHover={setHoveredGroupId}
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
              activeChatTabs.length > 0 || canShowSessions || (canShowPrompts && !promptsOpen) ? (
                <div className="flex items-center gap-2">
                  {activeChatTabs.length > 0 && (
                    <ChatFontSizeControl
                      override={activeChatFontSize}
                      defaultSize={defaultChatFontSize}
                      onChange={setActiveChatFontSize}
                    />
                  )}
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
            {groups.length === 0 && loadState === 'failed' && (
              // The hub couldn't answer (e.g. its socket dropped mid-read): not "no tabs".
              // It also loads again by itself once the hub's socket reopens.
              <div
                className="absolute inset-0 flex items-center justify-center p-6"
                data-testid="terminal-load-failed"
              >
                <div className="max-w-sm space-y-3 text-center">
                  <div className="text-sm font-medium text-muted-foreground">
                    Couldn't load this task's agents
                  </div>
                  <div className="text-xs text-muted-foreground/70">
                    The hub didn't answer. This retries when the connection comes back.
                  </div>
                  <div className="flex justify-center">
                    <Button size="sm" variant="outline" onClick={reload}>
                      Retry
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {groups.length === 0 && loadState === 'loaded' && emptyState}
            {groups.length === 0 && loadState === 'loaded' && !emptyState && (
              // No tab of one's own yet: someone working on a task another person created
              // (T-100) — the main agent is theirs, on their computer.
              <div
                className="absolute inset-0 flex items-center justify-center p-6"
                data-testid="terminal-empty-own"
              >
                <div className="max-w-sm space-y-3 text-center">
                  <div className="text-sm font-medium text-muted-foreground">
                    Start your own agent on this task
                  </div>
                  <div className="text-xs text-muted-foreground/70">
                    It runs on your computer, in your own folder. The task's other agents and
                    terminals stay with the people running them.
                  </div>
                  <div className="flex justify-center gap-2">
                    <Button size="sm" onClick={() => void createTab(defaultMode)}>
                      Start agent
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void createTab('terminal')}>
                      Terminal
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {groups
              .filter((group) => {
                const tab = group.tabs.length === 1 ? group.tabs[0] : undefined
                return (
                  mountedGroupIds.has(group.id) ||
                  (isActive && group.id === prefetchedGroupId && tab && isChatSupported(tab.mode))
                )
              })
              .map((group) => {
                const shown = group.id === activeGroupId
                return (
                  <div
                    key={group.id}
                    className={shown ? 'absolute inset-0' : HIDDEN_GROUP_CLASS}
                    inert={shown ? undefined : true}
                  >
                    <TerminalSplitGroup
                      // Focus and attach go to the shown group only: a hidden
                      // pane must never take focus.
                      ref={shown ? splitGroupRef : undefined}
                      panes={panesByGroup.get(group.id) ?? []}
                      isActive={isActive && shown}
                      prefetchOnly={!mountedGroupIds.has(group.id)}
                      paused={paused}
                      onAttached={shown ? handlePaneAttached : undefined}
                      onOpenUrl={onOpenUrl}
                      onOpenFile={onOpenFile}
                      onOpenArtifact={onOpenArtifact}
                      onOpenTask={onOpenTask}
                    />
                  </div>
                )
              })}
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
