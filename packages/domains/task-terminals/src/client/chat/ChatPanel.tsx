import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { CornerDownLeft } from 'lucide-react'
import { useChatAvailability } from '@slayzone/terminal/client/chat-availability'
import { ChatStorageNotice } from './ChatStorageNotice'
import { ChatOpenFailure } from './ChatOpenFailure'
import { useTRPCClient } from '../trpc'
import { useAnswerThreads } from './useAnswerThreads'
import { useSideQuestions } from './side-questions/useSideQuestions'
import { SideQuestionCard } from './side-questions/SideQuestionCard'
import { ChatThreadsPanel } from './ChatThreadsPanel'
import {
  toast,
  useAppearance,
  safeClipboardWriteText,
  useStableCallback,
  usePaletteContribution,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  cn
} from '@slayzone/ui'
import { CHAT_PANEL_GUTTER_CLASS } from './chat-layout'
import {
  hasPendingPrompt,
  isAwaitingUserQuestion,
  BackgroundJobsBanner,
  LiveBlockStore,
  LiveBlockStoreContext,
  selectUsageSummary,
  selectBackgroundJobs,
  selectCodexPlanReview,
  useChatSession
} from '@slayzone/terminal/client'
import { chatCapabilitiesForMode, chatProviderForMode } from '@slayzone/terminal-contracts'
import type { AgentState } from '@slayzone/terminal-contracts'
import { useArtifactUpload } from '@slayzone/editor/hooks'
import { useChatAttachments } from './attachments/useChatAttachments'
import { useChatScrollMemory } from './composer-state/useChatScrollMemory'
import { ChatViewContext } from './ChatViewContext'
import { RowUiStateContext, RowUiStateStore, collapseAllRows } from './row-ui-state'
import { TimelineRevealContext } from './timeline-reveal'
import { useChatMode } from './useChatMode'
import { useChatDefaults } from './useChatDefaults'
import { useChatModel } from './useChatModel'
import { useChatModels } from './useChatModels'
import { useChatEffort } from './useChatEffort'
import { useChatCollaboration } from './useChatCollaboration'
import { useChatFastMode } from './useChatFastMode'
import { useFollowBottom } from './useFollowBottom'
import { useChatActions } from './useChatActions'
import { useChatComposer } from './useChatComposer'
import { useChatDisplay } from './useChatDisplay'
import { useChatLifecycle } from './useChatLifecycle'
import { useChatPanelKeyboard } from './useChatPanelKeyboard'
import { useTurnOutline } from './useTurnOutline'
import { turnOutlinePaletteCommands } from './turn-outline-palette'
import { useCliCommandSnapshot } from './useCliCommandSnapshot'
import { ChatTimeline } from './ChatTimeline'
import { ChatComposer } from './ChatComposer'
import { PromptDock, type PromptKeyHandler } from './prompts/PromptDock'
import { CodexPlanPrompt } from './CodexPlanPrompt'
import { CommandTaskContext } from './tool-cards'
import { useCommandTaskActions } from './tool-cards/command-task-hooks'
import { useConversationActions } from './useConversationActions'
import { RewindDialog } from './RewindDialog'
import { RewindPicker, type RewindPickerKind } from './RewindPicker'
import { chatPaletteCommands, compactAction } from './palette/chat-palette-commands'
import { ToolFocusContext, ToolFocusStore } from './tool-cards/tool-focus'
import { FilesChangedPanel } from './files-changed/FilesChangedPanel'
import {
  activeUserRows,
  attachmentBytesOf,
  historySummary,
  sessionFileCount
} from './history-summary'
import { appendToDraft, formatDiffComment, type DiffLineComment } from './diff-comments/format'

export interface ChatPanelHandle {
  focus: () => void
}

export interface ChatPanelProps {
  isThread?: boolean
  onReturnAnswer?: (text: string) => void
  onQuoteReply?: (text: string) => void
  tabId: string
  taskId: string
  mode: string
  cwd: string
  isActive?: boolean
  providerFlagsOverride?: string | null
  permissionNotice?: string | null
  /** Cmd+Click on a URL → in-app slay browser. Cmd+Shift+Click always external. */
  onOpenUrl?: (url: string) => void
  /** Cmd+Click on a file:line:col reference → editor pane. */
  onOpenFile?: (filePath: string, options?: { position?: { line: number; col?: number } }) => void
  onOpenArtifact?: (artifactId: string) => void
  /**
   * From `terminal_tabs.agent_state`: how this tab's agent last ended. With the
   * startup mode it decides whether chat.start runs after hydrate (see
   * `useChatLifecycle`), e.g. so a warm session restores on reboot without the
   * user typing first. `running` is kept across shutdown, so it doubles as crash
   * recovery.
   */
  agentState?: AgentState
  /** The task's main tab (the startup mode applies to it). */
  isMain?: boolean
  isTemporary?: boolean
  /** "Continue in terminal": hand the conversation to the terminal agent (main tab). */
  onHandoff?: () => void
  /** Open the task's sessions sidebar (the palette's "Sessions…"). */
  onShowSessions?: () => void
  /**
   * The main tab's input API — same contract a terminal pane hands up, so the
   * task's Cmd+I / Cmd+Shift+I (title / description), screenshot paths and
   * focus requests reach a chat agent too. Text lands in the draft, never sent.
   */
  onReady?: (api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => void
}

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(
  function ChatPanelView(props, ref) {
    const trpcClient = useTRPCClient()
    const {
      tabId,
      taskId,
      mode,
      cwd,
      isActive = true,
      providerFlagsOverride,
      permissionNotice: overrideNotice,
      onOpenUrl,
      onOpenFile,
      onOpenArtifact,
      agentState,
      isMain,
      isTemporary,
      onHandoff,
      onShowSessions,
      onReady
    } = props
    const {
      state,
      timeline,
      inFlight,
      hydrating,
      loadError,
      hydrateError,
      reload,
      paging,
      loadPages,
      unloadPages,
      searchPages,
      permissionMode,
      prompts,
      submittingPrompts,
      sendMessage,
      retryMessage,
      sendToolResult,
      respondPermission,
      interrupt,
      abortAndPop,
      rewindPreview,
      rewind,
      fork,
      takeOver,
      reset: resetTimeline
    } = useChatSession({
      tabId,
      taskId,
      mode,
      cwd,
      providerFlagsOverride
    })
    // The whole history's summary: rows here, and for pages not loaded (paged
    // history) what the hub sent — the outline, rewind, files count and budget.
    const historyOfSession = useMemo(() => historySummary(timeline, paging), [timeline, paging])

    const appearance = useAppearance()
    const finalOnly = false
    const showLastMessageTools = false

    const { chatMode, handleModeChange, autoCapability } = useChatMode({
      taskId,
      mode,
      tabId,
      cwd,
      livePermissionMode: permissionMode
    })
    const chatDefaults = useChatDefaults(mode)
    const { chatModel, modelChanging, handleModelChange } = useChatModel({
      taskId,
      mode,
      tabId,
      cwd
    })
    const models = useChatModels({ taskId, mode, sessionKey: state.sessionId })
    const effortLevels = chatModel ? models.effortLevels(chatModel) : undefined
    const { chatEffort, effortChanging, handleEffortChange } = useChatEffort({
      taskId,
      mode,
      tabId,
      cwd
    })
    const {
      chatCollaboration,
      collaborationChanging,
      handleCollaborationChange,
      syncCollaboration
    } = useChatCollaboration({
      taskId,
      mode,
      tabId,
      cwd
    })
    const backgroundJobs = selectBackgroundJobs(state)
    const codexPlanReview = useMemo(
      () => (mode === 'codex-chat' ? selectCodexPlanReview(timeline, chatCollaboration) : null),
      [mode, timeline, chatCollaboration]
    )
    const { chatFastMode, fastModeChanging, handleFastModeChange } = useChatFastMode({
      taskId,
      mode,
      tabId,
      cwd
    })
    const promptCards = chatCapabilitiesForMode(mode).promptCards
    // The prompt dock's key handler, consulted first by the panel's keys.
    const promptKeysRef = useRef<PromptKeyHandler | null>(null)
    const [collapseSignal, setCollapseSignal] = useState(0)
    const follow = useFollowBottom(appearance.chatAutoScroll)
    const { scrollRef, contentRef, isAtBottom, scrollToBottom, captureAnchor } = follow
    // What rows have expanded, kept while they are scrolled out of view.
    const [rowUiState] = useState(() => new RowUiStateStore())
    const panelRef = useRef<HTMLDivElement>(null)

    const { chatApi, navigate } = useChatActions()

    const cliCommands = useCliCommandSnapshot({
      taskId,
      mode,
      live: state.cliCommands,
      liveDetails: state.cliCommandDetails,
      enabled: chatCapabilitiesForMode(mode).nativeSlashCommands
    })

    const { getFilePath: getArtifactFilePath } = useArtifactUpload(taskId, {
      folderName: 'Uploads'
    })

    // `/btw`: side questions, answered aside — never part of the conversation.
    const sideQuestions = useSideQuestions({ tabId, taskId, mode, cwd, providerFlagsOverride })

    const composer = useChatComposer({
      tabId,
      taskId,
      mode,
      cwd,
      providerFlagsOverride,
      isActive,
      sendMessage,
      inFlight,
      turnId: state.turnsClosed,
      sessionEnded: state.sessionEnded,
      abortAndPop,
      chatApi,
      navigate,
      getArtifactFilePath,
      scrollToBottom,
      handleEffortChange,
      models,
      chatModel,
      handleModelChange,
      cliCommands,
      attachmentsUsedBytes: attachmentBytesOf(historyOfSession),
      // "Stop & send" on a queued message: a live interrupt keeps the queue, which
      // then drains that message next (`chat.interrupt` → stopTurn, no restore).
      ...(chatCapabilitiesForMode(mode).liveInterrupt ? { interruptTurn: interrupt } : {}),
      // "Send now": a turn runs and no prompt waits for an answer.
      steerAvailable:
        inFlight && !(promptCards ? hasPendingPrompt(state) : isAwaitingUserQuestion(state)),
      ...(chatCapabilitiesForMode(mode).sideQuestions ? { onSideQuestion: sideQuestions.ask } : {})
    })

    const storage = useChatAvailability({
      tabId,
      active: isActive,
      historyReady: !hydrating && !loadError,
      onReady: useStableCallback(() => {
        reload()
        composer.retryDraftSave()
      })
    })

    const attachmentsApi = useChatAttachments({
      taskId,
      tabId,
      mode,
      onAdded: (added) => {
        composer.setAttachments((prev) => [...prev, ...added])
        composer.textareaRef.current?.focus()
      }
    })
    const takesAnyFile = chatCapabilitiesForMode(mode).attachments === 'blocks'

    useImperativeHandle(ref, () => ({
      focus: () => composer.textareaRef.current?.focus()
    }))

    // Text from outside the composer (inject title / description, a screenshot
    // path) replaces the selection — caret after it, focused — like typing it.
    const insertIntoDraft = useStableCallback((text: string): void => {
      const el = composer.textareaRef.current
      const value = el?.value ?? composer.draft
      const start = el?.selectionStart ?? value.length
      const end = el?.selectionEnd ?? value.length
      const caret = start + text.length
      composer.setDraft(value.slice(0, start) + text + value.slice(end))
      requestAnimationFrame(() => {
        const node = composer.textareaRef.current
        if (!node) return
        node.focus()
        node.setSelectionRange(caret, caret)
        composer.setCursorPos(caret)
      })
    })
    const announceReady = useStableCallback((): void => {
      onReady?.({
        sendInput: async (text) => insertIntoDraft(text),
        write: async (data) => {
          insertIntoDraft(data)
          return true
        },
        focus: () => composer.textareaRef.current?.focus(),
        clearBuffer: async () => {
          // A chat has no scrollback buffer to clear.
        }
      })
    })
    useEffect(() => {
      announceReady()
    }, [announceReady])

    const display = useChatDisplay({
      timeline,
      finalOnly,
      showLastMessageTools,
      groupActivity: true,
      inFlight,
      showThinking: true,
      searchThinking: appearance.chatShowThinking,
      follow,
      paging,
      loadPages,
      searchPages,
      summary: historyOfSession,
      unloadPages,
      cwd
    })
    const activeUsers = useMemo(
      () => activeUserRows(display.summary, display.conversationFolded),
      [display.summary, display.conversationFolded]
    )
    const { search } = display
    // The user turns: Cmd+K "Go to turn…" and the keys that jump to the previous / next one.
    const turnOutline = useTurnOutline({
      items: display.displayedTimeline,
      itemKey: display.itemKey,
      virtual: display.virtual,
      summary: display.summary,
      folded: display.folded,
      rowOf: display.rowOf,
      reveal: display.revealItem
    })

    // Files changed (chat E, plan 4.3): the panel beside the chat, opened at a file
    // or at the top; `seq` re-scrolls when the same file is asked for again.
    const filesCapable = chatCapabilitiesForMode(mode).filesChanged
    const [filesPanel, setFilesPanel] = useState<{
      path?: string
      captureId?: string
      seq: number
    } | null>(null)
    const openFilesPanel = useStableCallback((path?: string, captureId?: string): void => {
      setFilesPanel((prev) => ({
        ...(path ? { path } : {}),
        ...(captureId ? { captureId } : {}),
        seq: (prev?.seq ?? 0) + 1
      }))
    })
    const filesCount = useMemo(
      () => (filesCapable ? sessionFileCount(display.summary, display.conversationFolded) : 0),
      [filesCapable, display.summary, display.conversationFolded]
    )
    // Paged history: the panel shows every file change — the pages holding
    // them load (held while it is open).
    const filesPanelOpen = filesPanel !== null
    const { summary: historySummaryNow, conversationFolded, pinPages } = display
    useEffect(() => {
      if (!filesPanelOpen || !paging) {
        pinPages('files', null)
        return
      }
      const pages = new Set<number>()
      for (const f of historySummaryNow.files) {
        if (!conversationFolded.has(f.row)) pages.add(Math.floor(f.row / paging.pageRows))
      }
      const wanted = [...pages].filter((p) => p < paging.sealed)
      pinPages('files', wanted)
      loadPages(wanted)
    }, [filesPanelOpen, paging, historySummaryNow, conversationFolded, pinPages, loadPages])
    // Cards asked to show themselves (a files-changed row's file).
    const [toolFocus] = useState(() => new ToolFocusStore())

    // A comment on a diff line (chat E, plan 4.4) goes to the end of the draft
    // as text; the composer takes focus with the caret after it.
    const diffComments = chatCapabilitiesForMode(mode).diffComments
    const addDiffComment = useStableCallback((comment: DiffLineComment): void => {
      composer.setDraft((prev) => appendToDraft(prev, formatDiffComment(comment, cwd)))
      requestAnimationFrame(() => {
        const el = composer.textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
        composer.setCursorPos(el.value.length)
      })
    })

    // Edit & resend / rewind / fork on past messages; edit puts the text back
    // into the composer (the same draft Stop restores).
    const conversation = useConversationActions({
      mode,
      activeUsers,
      rewindPreview,
      rewind,
      fork,
      prefill: (text, attachments) => {
        composer.setAttachments(attachments ?? [])
        composer.setDraft(text)
        composer.textareaRef.current?.focus()
      }
    })

    // Where the timeline was scrolled survives remounts and reloads (per tab).
    useChatScrollMemory({
      tabId,
      mode,
      enabled: chatCapabilitiesForMode(mode).restoreComposerState,
      ready: !hydrating,
      scrollRef,
      captureAnchor,
      restoreAnchor: display.restoreAnchor,
      revealKey: display.revealAnchor
    })

    const copySessionId = useCallback(() => {
      if (!state.sessionId) return
      void safeClipboardWriteText(state.sessionId)
    }, [state.sessionId])

    const {
      resetting,
      restarting,
      displaySessionEnded,
      handleReset: resetImmediately,
      handleRestart
    } = useChatLifecycle({
      tabId,
      taskId,
      mode,
      cwd,
      providerFlagsOverride,
      agentState,
      isMain,
      isTemporary,
      shown: isActive,
      chatApi,
      inFlight,
      hydrating,
      loadFailed: (loadError ?? hydrateError) != null,
      state,
      resetTimeline,
      // Reset clears the composer: its text and its attached files.
      setDraft: (value: string) => {
        composer.setDraft(value)
        composer.setAttachments([])
      },
      clearQueue: composer.clearQueue
    })
    const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
    const handleReset = useCallback(() => {
      if (!resetting) setResetConfirmOpen(true)
    }, [resetting, setResetConfirmOpen])

    // Esc Esc / the palette's "Rewind…": the TUI's message list (chat E, plan 4.6).
    // Edit & resend puts the message back into the composer, so it waits for an
    // empty one — typed text is never replaced.
    const [pickerKind, setPickerKind] = useState<RewindPickerKind | null>(null)
    const openRewind = useStableCallback((kind: RewindPickerKind): void => {
      if (kind === 'edit' && composer.draft.trim() !== '') {
        toast('Rewinding puts the message back into the message box: empty it first.')
        return
      }
      if (conversation.view.activeIds.size === 0) {
        toast('Nothing to rewind yet.')
        return
      }
      setPickerKind(kind)
    })

    useChatPanelKeyboard({
      panelRef,
      scrollRef,
      search,
      inFlight,
      chatMode,
      handleModeChange,
      autoCapability,
      autocomplete: composer.autocomplete,
      handleStop: composer.handleStop,
      mode,
      promptKeysRef,
      ...(sideQuestions.open ? { onDismissSideQuestion: sideQuestions.dismiss } : {}),
      composerRef: composer.textareaRef,
      draftEmpty: composer.draft === '' && composer.attachments.length === 0,
      onClearDraft: composer.discardDraft,
      ...(conversation.view.canRewind ? { onDoubleEscape: () => openRewind('edit') } : {}),
      jumpTurn: turnOutline.jump,
      scrollToBottom,
      unstick: follow.unstick
    })

    // The chat's page in the app's Cmd+K palette while this tab is the active one
    // (the focused tab wins when a split shows two).
    // Compiler-memoized: identity changes only when an input does.
    const compact = compactAction(chatCapabilitiesForMode(mode), (text) => {
      void composer.sendCommand(text)
    })
    const paletteCommands = chatPaletteCommands({
      mode,
      inFlight,
      canRewind: conversation.view.canRewind,
      canFork: conversation.view.canFork,
      openRewind,
      ...(compact ? { compact } : {}),
      ...(onShowSessions ? { showSessions: onShowSessions } : {}),
      ...(chatModel && !inFlight && !modelChanging
        ? {
            model: {
              current: chatModel,
              options: models.models,
              change: (id) => void handleModelChange(id)
            }
          }
        : {}),
      ...(!inFlight
        ? {
            permissionMode: {
              current: chatMode,
              change: (next) => {
                handleModeChange(next).catch(() => {
                  /* toast already shown by hook */
                })
              },
              autoAvailable: autoCapability.optedIn
            }
          }
        : {}),
      ...(chatModel && models.supportsEffort(chatModel) && !inFlight && !effortChanging
        ? {
            effort: {
              current: chatEffort,
              ...(effortLevels ? { options: effortLevels } : {}),
              change: (next) => void handleEffortChange(next)
            }
          }
        : {}),
      ...(onHandoff && state.sessionId ? { handoff: onHandoff } : {}),
      ...(filesCapable
        ? { filesChanged: { count: filesCount, open: () => openFilesPanel() } }
        : {}),
      find: search.requestOpen,
      collapseAll: () => {
        // Rows scrolled out of view are closed too, when they come back.
        collapseAllRows(rowUiState, display.displayedTimeline, display.itemKey, timeline.length)
        setCollapseSignal((n) => n + 1)
      },
      copyLastResponse: display.copyLastResponse,
      copyConversation: display.copyAllMessages,
      ...(inFlight ? { stop: () => void composer.handleStop() } : {}),
      reset: () => void handleReset(),
      // The turn outline: go to a turn, previous / next turn.
      extra: turnOutlinePaletteCommands({
        turns: turnOutline.turns,
        reveal: display.revealItem,
        jump: turnOutline.jump
      })
    })
    const palette = usePaletteContribution(
      taskId,
      paletteCommands,
      chatCapabilitiesForMode(mode).commandPalette && isActive
    )

    // Adapt the `(path, { position })` signature used by host wiring to the flat
    // `(path, line, col)` shape LinkifiedText expects.
    const handleOpenFile = useMemo(() => {
      if (!onOpenFile) return undefined
      return (path: string, line?: number, col?: number) => {
        onOpenFile(path, line != null ? { position: { line, col } } : undefined)
      }
    }, [onOpenFile])

    const quoteReply = useStableCallback((text: string): void => {
      if (props.onQuoteReply) {
        props.onQuoteReply(text)
        return
      }
      composer.setDraft((prev) =>
        appendToDraft(
          prev,
          text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        )
      )
      requestAnimationFrame(() => {
        const el = composer.textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
        composer.setCursorPos(el.value.length)
      })
    })

    const threadApi = useAnswerThreads(
      { tabId, taskId, mode, cwd, providerFlagsOverride },
      !props.isThread && chatCapabilitiesForMode(mode).fork,
      state.sessionId
    )
    const [returnDraft, setReturnDraft] = useState<{ threadId: string; text: string } | null>(null)
    const [returnSending, setReturnSending] = useState(false)
    const sendThreadAnswer = useStableCallback(async (): Promise<void> => {
      const thread = threadApi.threads.find((thread) => thread.id === returnDraft?.threadId)
      if (!returnDraft?.text.trim() || !thread || returnSending) return
      if (thread.parentConversationId !== state.sessionId) {
        toast('Return to the source conversation before sending this answer.')
        return
      }
      setReturnSending(true)
      const text = `Answer from thread “${thread.title}”:\n\n${returnDraft.text.trim()}\n\n[Open thread](#chat-thread:${thread.id})`
      await trpcClient.chat.queue.push
        .mutate({
          tabId,
          send: text,
          original: text,
          expectedConversationId: thread.parentConversationId
        })
        .then(
          () => {
            setReturnDraft(null)
            toast(
              inFlight ? 'Thread answer queued for main chat' : 'Thread answer sent to main chat'
            )
          },
          (err: unknown) => {
            toast(`Couldn't send answer: ${err instanceof Error ? err.message : String(err)}`)
          }
        )
        .then(() => setReturnSending(false))
    })

    const chatView = useMemo(
      () => ({
        collapseSignal,
        finalOnly,
        fileEditsOpenByDefault: appearance.chatFileEditsOpenByDefault,
        showMessageMeta: appearance.chatShowMessageMeta,
        search: { query: search.query, caseSensitive: search.caseSensitive },
        provider: chatProviderForMode(mode),
        setChatMode: handleModeChange,
        sendMessage: (text: string) => {
          void sendMessage(text)
        },
        retryMessage: (id: string) => {
          void retryMessage(id)
        },
        restartAgent: () => {
          void handleRestart()
        },
        takeOver: () => {
          takeOver().catch((err: unknown) =>
            toast(`Couldn't continue here: ${err instanceof Error ? err.message : String(err)}`)
          )
        },
        quoteReply,
        threads: threadApi.view,
        sendToolResult,
        promptCards,
        prompts,
        submittingPrompts,
        respondPermission,
        autoModeAvailable: autoCapability.optedIn,
        cwd,
        timeline,
        childIndex: state.childIndex,
        inFlight,
        onOpenUrl,
        onOpenFile: handleOpenFile,
        onOpenArtifact,
        conversation: conversation.view,
        branches: display.branches,
        history: display.history,
        latestAskId: display.summary.asks.at(-1)?.id ?? null,
        ...(filesCapable ? { filesPanel: { open: openFilesPanel } } : {}),
        ...(diffComments ? { addDiffComment } : {})
      }),
      [
        collapseSignal,
        finalOnly,
        appearance.chatFileEditsOpenByDefault,
        appearance.chatShowMessageMeta,
        search.query,
        search.caseSensitive,
        mode,
        handleModeChange,
        sendMessage,
        retryMessage,
        handleRestart,
        takeOver,
        quoteReply,
        threadApi.view,
        sendToolResult,
        promptCards,
        prompts,
        submittingPrompts,
        respondPermission,
        autoCapability.optedIn,
        cwd,
        timeline,
        state.childIndex,
        inFlight,
        onOpenUrl,
        handleOpenFile,
        onOpenArtifact,
        conversation.view,
        display.branches,
        display.history,
        display.summary,
        filesCapable,
        openFilesPanel,
        diffComments,
        addDiffComment
      ]
    )

    const isEmpty =
      timeline.length === 0 || (timeline.length === 1 && timeline[0]?.kind === 'session-start')
    // The chat did not open: nothing can be sent, so the failure takes the
    // composer's place (the composer stays mounted, hidden, so a draft survives).
    const openError = loadError ?? hydrateError ?? storage.error

    // What streams right now reaches only the rows that stream (plan 3.2): the
    // store's identity never changes, so providing it re-renders nothing, and a
    // delta notifies just the row subscribed to its key.
    const [liveStore] = useState(() => new LiveBlockStore())
    useLayoutEffect(() => {
      liveStore.publish(state.live)
    }, [liveStore, state.live])
    // Command cards poll their live output only while this tab is on screen.
    const commandTaskScope = useMemo(() => ({ tabId, active: isActive }), [tabId, isActive])

    return (
      <ChatViewContext.Provider value={chatView}>
        <TimelineRevealContext.Provider value={display.revealItem}>
          <RowUiStateContext.Provider value={rowUiState}>
            <LiveBlockStoreContext.Provider value={liveStore}>
              <CommandTaskContext.Provider value={commandTaskScope}>
                <ToolFocusContext.Provider value={toolFocus}>
                  {/* The files-changed panel sits beside the chat; in a narrow pane it covers it. */}
                  <div className="@container relative flex h-full min-w-0 flex-1">
                    <div
                      ref={panelRef}
                      data-chat-panel
                      className={cn(
                        'relative flex flex-col h-full min-w-0 flex-1 bg-background',
                        CHAT_PANEL_GUTTER_CLASS
                      )}
                      style={{ fontSize: `${appearance.terminalFontSize}px` }}
                      onFocus={palette.claim}
                      onDragEnter={attachmentsApi.onDragEnter}
                      onDragOver={attachmentsApi.onDragOver}
                      onDragLeave={attachmentsApi.onDragLeave}
                      onDrop={attachmentsApi.onDrop}
                      onMouseUp={(e) => {
                        // Click on panel background → focus composer. Skip if user clicked an
                        // interactive element (button/link/input) or completed a text selection.
                        const target = e.target as HTMLElement | null
                        if (!target) return
                        if (
                          target.closest(
                            'button, a, input, textarea, select, summary, [role="button"], [role="menuitem"], [contenteditable="true"]'
                          )
                        )
                          return
                        const sel = window.getSelection()
                        if (sel && !sel.isCollapsed) return
                        composer.textareaRef.current?.focus()
                      }}
                      onClickCapture={(e) => {
                        // Event-delegated link interception for markdown-rendered anchors only.
                        // Skip LinkifiedText anchors — they own their click semantics via
                        // `data-linkified` and would otherwise double-fire (capture-phase parent
                        // before child onClick).
                        // Mirrors terminal modifier semantics:
                        //   ⌘+Click       → in-app slay browser (onOpenUrl)
                        //   ⌘+Shift+Click → external
                        //   bare click    → external (markdown anchors are click affordances;
                        //                  doing nothing on bare click would feel broken).
                        const target = e.target as HTMLElement | null
                        const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
                        if (!anchor) return
                        if (anchor.dataset.linkified === 'true') return
                        const href = anchor.getAttribute('href') ?? ''
                        if (href.startsWith('#chat-thread:')) {
                          e.preventDefault()
                          const id = href.slice('#chat-thread:'.length)
                          const thread = threadApi.threads.find((thread) => thread.id === id)
                          if (thread) threadApi.view?.open(thread)
                          return
                        }
                        if (!/^https?:\/\//i.test(href)) return
                        e.preventDefault()
                        const mod = e.metaKey || e.ctrlKey
                        if (mod && e.shiftKey) navigate.openExternal(href)
                        else if (mod && onOpenUrl) onOpenUrl(href)
                        else navigate.openExternal(href)
                      }}
                    >
                      {/* Panel-wide drop overlay */}
                      {attachmentsApi.isDragging && (
                        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-primary/5 ring-2 ring-inset ring-primary/60 text-sm text-primary/80">
                          {takesAnyFile
                            ? 'Drop files to attach (images, PDFs, text)'
                            : 'Drop image…'}
                        </div>
                      )}

                      {openError ? (
                        isEmpty && (
                          <ChatOpenFailure
                            status={storage.status}
                            error={openError}
                            placement="center"
                            onRetry={storage.retry}
                          />
                        )
                      ) : (
                        <ChatStorageNotice status={storage.status} onRetry={storage.retry} />
                      )}
                      <ChatTimeline
                        overrideNotice={overrideNotice}
                        search={search}
                        state={state}
                        hydrating={hydrating}
                        isEmpty={isEmpty}
                        inFlight={inFlight}
                        stopping={composer.stopping}
                        awaitingUser={
                          promptCards ? hasPendingPrompt(state) : isAwaitingUserQuestion(state)
                        }
                        appearance={appearance}
                        items={display.displayedTimeline}
                        activityTurns={display.activityTurns}
                        folded={display.folded}
                        virtual={display.virtual}
                        scrollRef={display.virtual.bindScroller}
                        itemKey={display.itemKey}
                        rowOf={display.rowOf}
                        contentRef={contentRef}
                        isAtBottom={isAtBottom}
                        scrollToBottom={scrollToBottom}
                        sendMessage={sendMessage}
                        copyLastResponse={display.copyLastResponse}
                        copyAllMessages={display.copyAllMessages}
                        copySessionId={copySessionId}
                        setCollapseSignal={setCollapseSignal}
                        handleReset={handleReset}
                        resetting={resetting}
                        {...(onHandoff && state.sessionId ? { onHandoff } : {})}
                      />

                      {codexPlanReview && (
                        <CodexPlanPrompt
                          key={codexPlanReview.planId}
                          review={codexPlanReview}
                          target={{ tabId, taskId, mode, cwd }}
                          onResolved={syncCollaboration}
                        />
                      )}
                      <PromptDock keysRef={promptKeysRef} autoFocus={isActive} />
                      {sideQuestions.open && (
                        <SideQuestionCard
                          exchanges={sideQuestions.exchanges}
                          onDismiss={sideQuestions.dismiss}
                        />
                      )}
                      <RewindDialog dialog={conversation.dialog} />
                      <AlertDialog
                        open={resetConfirmOpen}
                        onOpenChange={(open) => {
                          if (!open && !resetting) setResetConfirmOpen(false)
                        }}
                      >
                        <AlertDialogContent data-testid="chat-reset-dialog">
                          <AlertDialogHeader>
                            <AlertDialogTitle>Reset chat?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Clear this chat’s message history and start a new conversation? Files
                              changed by the agent stay on disk.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel disabled={resetting}>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              disabled={resetting}
                              onClick={(event) => {
                                event.preventDefault()
                                void resetImmediately().finally(() => setResetConfirmOpen(false))
                              }}
                            >
                              {resetting ? 'Resetting…' : 'Reset chat'}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                      <RewindPicker
                        kind={pickerKind}
                        activeUsers={activeUsers}
                        view={conversation.view}
                        onClose={() => setPickerKind(null)}
                      />

                      {props.onReturnAnswer && !inFlight && (
                        <div className="px-4 pt-2">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                            onClick={() => {
                              for (let i = timeline.length - 1; i >= 0; i--) {
                                const item = timeline[i]
                                if (item?.kind === 'text' && item.parentToolUseId == null) {
                                  props.onReturnAnswer?.(item.text)
                                  return
                                }
                              }
                            }}
                          >
                            <CornerDownLeft className="size-3" />
                            Send to main
                          </button>
                        </div>
                      )}
                      {openError && !isEmpty && (
                        <ChatOpenFailure
                          status={storage.status}
                          error={openError}
                          placement="bottom"
                          onRetry={storage.retry}
                        />
                      )}
                      <div
                        data-testid="chat-composer-slot"
                        className={openError ? 'hidden' : 'contents'}
                      >
                        <ChatComposer
                          notices={
                            <>
                              {composer.draftConflictAvailable && (
                                <div
                                  role="status"
                                  className="mb-1.5 flex items-center justify-between gap-3 rounded-2xl border border-border/40 py-1.5 pl-4 pr-1.5 text-xs"
                                >
                                  <p className="text-muted-foreground">
                                    Saved and local drafts differ. Keep both before saving.
                                  </p>
                                  <div className="flex shrink-0 items-center gap-1">
                                    <button
                                      type="button"
                                      className="rounded-full border border-border/60 px-3 py-1 hover:bg-accent"
                                      onClick={composer.recoverDraftConflict}
                                    >
                                      Keep both
                                    </button>
                                    <button
                                      type="button"
                                      title="Keep only the current draft"
                                      className="rounded-full px-3 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                      onClick={composer.dismissDraftConflict}
                                    >
                                      Dismiss
                                    </button>
                                  </div>
                                </div>
                              )}
                              {composer.legacyDraftAvailable && (
                                <div
                                  role="status"
                                  className="mb-1.5 flex items-center justify-between gap-3 rounded-2xl border border-border/40 py-1.5 pl-4 pr-1.5 text-xs"
                                >
                                  <p className="text-muted-foreground">
                                    Older unsaved draft on this device. Recover adds it to this
                                    chat.
                                  </p>
                                  <button
                                    type="button"
                                    className="shrink-0 rounded-full border border-border/60 px-3 py-1 hover:bg-accent"
                                    onClick={composer.recoverLegacyDraft}
                                  >
                                    Recover draft
                                  </button>
                                </div>
                              )}
                            </>
                          }
                          backgroundJobs={
                            backgroundJobs.length > 0 ? (
                              <ComposerBackgroundJobs jobs={backgroundJobs} />
                            ) : null
                          }
                          compact={props.isThread}
                          hasPlanReview={!!codexPlanReview}
                          appearance={appearance}
                          finalOnly={finalOnly}
                          inFlight={inFlight}
                          mode={mode}
                          queuedMessages={composer.queuedMessages}
                          removeQueue={composer.removeQueue}
                          queueApi={composer.queueApi}
                          attachments={composer.attachments}
                          setAttachments={composer.setAttachments}
                          attachmentsApi={attachmentsApi}
                          autocomplete={composer.autocomplete}
                          textareaRef={composer.textareaRef}
                          draft={composer.draft}
                          setDraft={composer.setDraft}
                          argumentHint={composer.argumentHint}
                          setCursorPos={composer.setCursorPos}
                          onKeyDown={composer.onKeyDown}
                          handleSend={composer.handleSend}
                          handleStop={composer.handleStop}
                          stopping={composer.stopping}
                          historySearch={composer.historySearch}
                          usage={selectUsageSummary(state)}
                          displaySessionEnded={displaySessionEnded}
                          handleRestart={handleRestart}
                          restarting={restarting}
                          handleReset={handleReset}
                          resetting={resetting}
                          chatMode={chatMode}
                          handleModeChange={handleModeChange}
                          autoCapability={autoCapability}
                          chatDefaults={chatDefaults}
                          chatModel={chatModel}
                          models={models}
                          handleModelChange={handleModelChange}
                          modelChanging={modelChanging}
                          chatEffort={chatEffort}
                          handleEffortChange={handleEffortChange}
                          effortChanging={effortChanging}
                          chatCollaboration={chatCollaboration}
                          handleCollaborationChange={handleCollaborationChange}
                          collaborationChanging={collaborationChanging}
                          chatFastMode={chatFastMode}
                          handleFastModeChange={handleFastModeChange}
                          fastModeChanging={fastModeChanging}
                        />
                      </div>
                    </div>
                    {filesPanel && (
                      <FilesChangedPanel
                        timeline={timeline}
                        cwd={cwd}
                        {...(filesPanel.path ? { focusPath: filesPanel.path } : {})}
                        focusSeq={filesPanel.seq}
                        captureId={filesPanel.captureId}
                        onClose={() => {
                          setFilesPanel(null)
                          composer.textareaRef.current?.focus()
                        }}
                        className="absolute inset-0 z-30 @min-[56rem]:static @min-[56rem]:w-[45%] @min-[56rem]:max-w-[720px] @min-[56rem]:shrink-0 @min-[56rem]:border-l @min-[56rem]:border-border"
                      />
                    )}
                    {threadApi.panel && (
                      <ChatThreadsPanel
                        key={`${threadApi.panel.conversationId}:${threadApi.panel.sourceMessageId}:${threadApi.panel.answerId}`}
                        threads={threadApi.threads.filter(
                          (thread) =>
                            thread.answerId === threadApi.panel?.answerId &&
                            thread.sourceMessageId === threadApi.panel?.sourceMessageId
                        )}
                        activeId={threadApi.panel.activeId}
                        creating={threadApi.creating}
                        onSelect={threadApi.select}
                        onCreate={threadApi.create}
                        onClose={threadApi.close}
                        renderThread={(thread, active) => (
                          <ChatPanel
                            tabId={thread.id}
                            taskId={taskId}
                            mode={mode}
                            cwd={cwd}
                            providerFlagsOverride={providerFlagsOverride}
                            isThread
                            isActive={isActive && active}
                            onOpenUrl={onOpenUrl}
                            onOpenFile={onOpenFile}
                            onOpenArtifact={onOpenArtifact}
                            onQuoteReply={quoteReply}
                            onReturnAnswer={(text) => setReturnDraft({ threadId: thread.id, text })}
                          />
                        )}
                      />
                    )}
                    <AlertDialog
                      open={returnDraft !== null}
                      onOpenChange={(open) => {
                        if (!open && !returnSending) setReturnDraft(null)
                      }}
                    >
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Send answer to main</AlertDialogTitle>
                          <AlertDialogDescription>
                            Review the conclusion. A link to the thread is included.{' '}
                            {inFlight
                              ? 'Main is working; the answer will be queued.'
                              : 'The answer will be sent as the next message.'}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <textarea
                          aria-label="Thread conclusion"
                          value={returnDraft?.text ?? ''}
                          onChange={(e) =>
                            setReturnDraft((prev) =>
                              prev ? { ...prev, text: e.target.value } : null
                            )
                          }
                          className="min-h-36 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                        />
                        <AlertDialogFooter>
                          <AlertDialogCancel disabled={returnSending}>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            disabled={returnSending || !returnDraft?.text.trim()}
                            onClick={(e) => {
                              e.preventDefault()
                              void sendThreadAnswer()
                            }}
                          >
                            {returnSending
                              ? 'Sending…'
                              : inFlight
                                ? 'Queue for main'
                                : 'Send to main'}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </ToolFocusContext.Provider>
              </CommandTaskContext.Provider>
            </LiveBlockStoreContext.Provider>
          </RowUiStateContext.Provider>
        </TimelineRevealContext.Provider>
      </ChatViewContext.Provider>
    )
  }
)

/** Composer-owned jobs use the same session scope as command cards. */
function ComposerBackgroundJobs(props: React.ComponentProps<typeof BackgroundJobsBanner>) {
  const commandTasks = useCommandTaskActions()
  return (
    <BackgroundJobsBanner
      {...props}
      onStop={(shell) => {
        if (shell.shellId) commandTasks.stop(shell.shellId)
      }}
    />
  )
}
