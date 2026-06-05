import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { toast, useAppearance } from '@slayzone/ui'
import { useChatSession } from '@slayzone/terminal/client'
import { useImagePasteDrop, useArtifactUpload, type ArtifactRef } from '@slayzone/editor/hooks'
import { ChatViewContext } from './ChatViewContext'
import { useChatMode } from './useChatMode'
import { useChatModel } from './useChatModel'
import { useChatEffort } from './useChatEffort'
import { useChatCollaboration } from './useChatCollaboration'
import { useChatFastMode } from './useChatFastMode'
import { useFollowBottom } from './useFollowBottom'
import { useChatActions } from './useChatActions'
import { useChatComposer } from './useChatComposer'
import { useChatDisplay } from './useChatDisplay'
import { useChatLifecycle } from './useChatLifecycle'
import { useChatPanelKeyboard } from './useChatPanelKeyboard'
import { ChatTimeline } from './ChatTimeline'
import { ChatComposer } from './ChatComposer'

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
   * From `terminal_tabs.was_spawned`: was the chat subprocess alive when the
   * app last touched this tab. True → after hydrate, auto-call chat.start so
   * a warm session restores on reboot without the user typing first. The flag
   * is sticky across shutdown (cleared only on user-initiated kill /
   * subprocess exit), so it doubles as crash recovery.
   */
  wasSpawned?: boolean
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
      wasSpawned
    } = props
    const {
      state,
      timeline,
      inFlight,
      hydrating,
      permissionMode,
      permissionRequests,
      sendMessage,
      sendToolResult,
      respondPermission,
      abortAndPop,
      reset: resetTimeline
    } = useChatSession({
      tabId,
      taskId,
      mode,
      cwd,
      providerFlagsOverride
    })

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
    const [collapseSignal, setCollapseSignal] = useState(0)
    const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useFollowBottom()
    const panelRef = useRef<HTMLDivElement>(null)

    const { chatApi, navigate } = useChatActions()

    const { uploadFiles: uploadImageFiles, getFilePath: getArtifactFilePath } = useArtifactUpload(
      taskId,
      { folderName: 'Uploads' }
    )

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
      handleEffortChange
    })

    const imagePasteDrop = useImagePasteDrop<ArtifactRef>({
      onUpload: uploadImageFiles,
      onInsert: (results) => {
        composer.setAttachments((prev) => [...prev, ...results])
        composer.textareaRef.current?.focus()
      },
      onError: (err) =>
        toast(`Image upload failed: ${err instanceof Error ? err.message : String(err)}`)
    })

    useImperativeHandle(ref, () => ({
      focus: () => composer.textareaRef.current?.focus()
    }))

    const display = useChatDisplay({ timeline, finalOnly, showLastMessageTools, scrollRef })
    const { search } = display

    const copySessionId = useCallback(() => {
      if (!state.sessionId) return
      void navigator.clipboard.writeText(state.sessionId)
    }, [state.sessionId])

    const { resetting, restarting, displaySessionEnded, handleReset, handleRestart } =
      useChatLifecycle({
        tabId,
        taskId,
        mode,
        cwd,
        providerFlagsOverride,
        wasSpawned,
        chatApi,
        inFlight,
        hydrating,
        state,
        resetTimeline,
        setDraft: composer.setDraft,
        clearQueue: composer.clearQueue
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
      mode
    })

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
        setChatMode: handleModeChange,
        sendMessage: (text: string) => {
          void sendMessage(text)
        },
        sendToolResult,
        permissionRequests,
        respondPermission,
        abortAgent: async () => {
          void composer.clearQueue()
          await abortAndPop()
        },
        timeline,
        childIndex: state.childIndex,
        onOpenUrl,
        onOpenFile: handleOpenFile
      }),
      [
        collapseSignal,
        finalOnly,
        appearance.chatFileEditsOpenByDefault,
        appearance.chatShowMessageMeta,
        search.query,
        search.caseSensitive,
        handleModeChange,
        sendMessage,
        sendToolResult,
        permissionRequests,
        respondPermission,
        abortAndPop,
        composer.clearQueue,
        timeline,
        state.childIndex,
        onOpenUrl,
        handleOpenFile
      ]
    )

    const isEmpty =
      timeline.length === 0 || (timeline.length === 1 && timeline[0].kind === 'session-start')

    return (
      <ChatViewContext.Provider value={chatView}>
        <div
          ref={panelRef}
          data-chat-panel
          className="relative flex flex-col h-full bg-background"
          style={{ fontSize: `${appearance.terminalFontSize}px` }}
          onDragEnter={(e) => {
            if (e.dataTransfer?.types.includes('Files')) {
              e.preventDefault()
              imagePasteDrop.onDragEnter()
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
          }}
          onDragLeave={() => imagePasteDrop.onDragLeave()}
          onDrop={(e) => {
            const files = imagePasteDrop.extractImageFiles(e.dataTransfer)
            imagePasteDrop.resetDrag()
            if (files.length === 0) return
            e.preventDefault()
            void imagePasteDrop.handleFiles(files)
          }}
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
          {imagePasteDrop.isDragging && (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-primary/5 ring-2 ring-inset ring-primary/60 text-sm text-primary/80">
              Drop image…
            </div>
          )}

          <ChatTimeline
            overrideNotice={overrideNotice}
            search={search}
            state={state}
            hydrating={hydrating}
            isEmpty={isEmpty}
            inFlight={inFlight}
            appearance={appearance}
            hiddenCount={display.hiddenCount}
            PAGE_SIZE={display.PAGE_SIZE}
            setVisibleCount={display.setVisibleCount}
            visibleItems={display.visibleItems}
            visibleStart={display.visibleStart}
            itemKey={display.itemKey}
            scrollRef={scrollRef}
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
          />

          <ChatComposer
            appearance={appearance}
            finalOnly={finalOnly}
            inFlight={inFlight}
            mode={mode}
            queuedMessages={composer.queuedMessages}
            removeQueue={composer.removeQueue}
            attachments={composer.attachments}
            setAttachments={composer.setAttachments}
            imagePasteDrop={imagePasteDrop}
            autocomplete={composer.autocomplete}
            textareaRef={composer.textareaRef}
            draft={composer.draft}
            setDraft={composer.setDraft}
            setCursorPos={composer.setCursorPos}
            onKeyDown={composer.onKeyDown}
            handleSend={composer.handleSend}
            handleStop={composer.handleStop}
            displaySessionEnded={displaySessionEnded}
            handleRestart={handleRestart}
            restarting={restarting}
            handleReset={handleReset}
            resetting={resetting}
            chatMode={chatMode}
            handleModeChange={handleModeChange}
            autoCapability={autoCapability}
            chatModel={chatModel}
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
      </ChatViewContext.Provider>
    )
  }
)
