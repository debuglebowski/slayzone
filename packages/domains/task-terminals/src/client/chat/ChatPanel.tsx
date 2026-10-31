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
import {
  toast,
  useAppearance,
  safeClipboardWriteText,
  useStableCallback,
  usePaletteContribution
} from '@slayzone/ui'
import {
  hasPendingPrompt,
  isAwaitingUserQuestion,
  LiveBlockStore,
  LiveBlockStoreContext,
  selectUsageSummary,
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
import { CommandTaskContext } from './tool-cards'
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
}

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(
  function ChatPanel(props, ref) {
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
      agentState,
      isMain,
      isTemporary,
      onHandoff,
      onShowSessions
    } = props
    const {
      state,
      timeline,
      inFlight,
      hydrating,
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
    const finalOnly = !appearance.chatShowTools
    const showLastMessageTools = appearance.chatShowLastMessageTools

    const { chatMode, handleModeChange, autoCapability } = useChatMode({
      taskId,
      mode,
      tabId,
      cwd,
      livePermissionMode: permissionMode
    })
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
    const { chatCollaboration, collaborationChanging, handleCollaborationChange } =
      useChatCollaboration({
        taskId,
        mode,
        tabId,
        cwd
      })
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
    const follow = useFollowBottom()
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

    const composer = useChatComposer({
      tabId,
      taskId,
      mode,
      cwd,
      providerFlagsOverride,
      isActive,
      sendMessage,
      inFlight,
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
      // "Send now" on a queued message: a live interrupt keeps the queue, which
      // then drains that message next (`chat.interrupt` → stopTurn, no restore).
      ...(chatCapabilitiesForMode(mode).liveInterrupt ? { interruptTurn: interrupt } : {})
    })

    const attachmentsApi = useChatAttachments({
      taskId,
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

    const display = useChatDisplay({
      timeline,
      finalOnly,
      showLastMessageTools,
      follow,
      paging,
      loadPages,
      searchPages,
      summary: historyOfSession,
      unloadPages
    })
    const activeUsers = useMemo(
      () => activeUserRows(display.summary, display.conversationFolded),
      [display.summary, display.conversationFolded]
    )
    const { search } = display
    // The turn outline and its keys (jump to the previous / next user turn).
    const turnOutline = useTurnOutline({
      items: display.displayedTimeline,
      itemKey: display.itemKey,
      virtual: display.virtual,
      turnOpen: inFlight,
      summary: display.summary,
      folded: display.folded,
      rowOf: display.rowOf,
      reveal: display.revealItem
    })

    // Files changed (chat E, plan 4.3): the panel beside the chat, opened at a file
    // or at the top; `seq` re-scrolls when the same file is asked for again.
    const filesCapable = chatCapabilitiesForMode(mode).filesChanged
    const [filesPanel, setFilesPanel] = useState<{ path?: string; seq: number } | null>(null)
    const openFilesPanel = useStableCallback((path?: string): void => {
      setFilesPanel((prev) => ({ ...(path ? { path } : {}), seq: (prev?.seq ?? 0) + 1 }))
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
      prefill: (text: string) => {
        composer.setDraft(text)
        composer.textareaRef.current?.focus()
      }
    })

    // Where the timeline was scrolled survives remounts and reloads (per tab).
    useChatScrollMemory({
      tabId,
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

    const { resetting, restarting, displaySessionEnded, handleReset, handleRestart } =
      useChatLifecycle({
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
        state,
        resetTimeline,
        // Reset clears the composer: its text and its attached files.
        setDraft: (value: string) => {
          composer.setDraft(value)
          composer.setAttachments([])
        },
        clearQueue: composer.clearQueue
      })

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
      composerRef: composer.textareaRef,
      draftEmpty: composer.draft.trim() === '' && composer.attachments.length === 0,
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
        sendToolResult,
        promptCards,
        prompts,
        submittingPrompts,
        respondPermission,
        autoModeAvailable: autoCapability.optedIn,
        cwd,
        timeline,
        childIndex: state.childIndex,
        onOpenUrl,
        onOpenFile: handleOpenFile,
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
        sendToolResult,
        promptCards,
        prompts,
        submittingPrompts,
        respondPermission,
        autoCapability.optedIn,
        cwd,
        timeline,
        state.childIndex,
        onOpenUrl,
        handleOpenFile,
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
                  <div className="@container relative flex h-full">
                    <div
                      ref={panelRef}
                      data-chat-panel
                      className="relative flex flex-col h-full min-w-0 flex-1 bg-background"
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
                            'button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"]'
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

                      <ChatTimeline
                        overrideNotice={overrideNotice}
                        search={search}
                        state={state}
                        hydrating={hydrating}
                        isEmpty={isEmpty}
                        inFlight={inFlight}
                        awaitingUser={
                          promptCards ? hasPendingPrompt(state) : isAwaitingUserQuestion(state)
                        }
                        appearance={appearance}
                        items={display.displayedTimeline}
                        virtual={display.virtual}
                        scrollRef={display.virtual.bindScroller}
                        itemKey={display.itemKey}
                        rowOf={display.rowOf}
                        turns={turnOutline.turns}
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

                      <PromptDock keysRef={promptKeysRef} autoFocus={isActive} />
                      <RewindDialog dialog={conversation.dialog} />
                      <RewindPicker
                        kind={pickerKind}
                        activeUsers={activeUsers}
                        view={conversation.view}
                        onClose={() => setPickerKind(null)}
                      />

                      <ChatComposer
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
                        {...(filesCapable
                          ? {
                              filesChanged: {
                                count: filesCount,
                                open: filesPanel !== null,
                                toggle: () => {
                                  if (filesPanel) setFilesPanel(null)
                                  else openFilesPanel()
                                }
                              }
                            }
                          : {})}
                      />
                    </div>
                    {filesPanel && (
                      <FilesChangedPanel
                        timeline={timeline}
                        cwd={cwd}
                        {...(filesPanel.path ? { focusPath: filesPanel.path } : {})}
                        focusSeq={filesPanel.seq}
                        onClose={() => {
                          setFilesPanel(null)
                          composer.textareaRef.current?.focus()
                        }}
                        className="absolute inset-0 z-30 @min-[56rem]:static @min-[56rem]:w-[45%] @min-[56rem]:max-w-[720px] @min-[56rem]:shrink-0 @min-[56rem]:border-l @min-[56rem]:border-border"
                      />
                    )}
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
