import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Key } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { useFollowBottom } from './useFollowBottom'
import {
  ArrowUp,
  Square,
  X as XIcon,
  Sparkles,
  ArrowDown,
  RotateCcw,
  Filter,
} from 'lucide-react'
import { ChatViewContext } from './ChatViewContext'
import { ChatSearchBar } from './ChatSearchBar'
import { useChatMode } from './useChatMode'
import { useChatModel } from './useChatModel'
import { useChatEffort } from './useChatEffort'
import { useChatQueue } from './useChatQueue'
import { useChatSearch } from './useChatSearch'
import { modelSupportsEffort } from '@slayzone/terminal/shared'
import {
  cn,
  toast,
  AgentModePill,
  AgentModelPill,
  AgentEffortPill,
  nextAgentMode,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Switch,
  useAppearance,
} from '@slayzone/ui'
import { ConfirmDisplayModeDialog } from '../ConfirmDisplayModeDialog'
import type { TabDisplayMode } from '../../shared/types'
import { useChatSession, BackgroundJobsBanner, PulseGrid, deriveLoadingLabel, type TimelineItem } from '@slayzone/terminal/client'
import { useImagePasteDrop, useArtifactUpload, type ArtifactRef } from '@slayzone/editor'
import { AutocompleteMenu } from './autocomplete/AutocompleteMenu'
import { useAutocomplete } from './autocomplete/useAutocomplete'
import { createSkillsSource } from './autocomplete/sources/skills'
import { createCommandsSource } from './autocomplete/sources/commands'
import { createAgentsSource } from './autocomplete/sources/agents'
import { createBuiltinsSource } from './autocomplete/sources/builtins'
import { createFilesSource } from './autocomplete/sources/files'
import type { AutocompleteSource, ChatActions, NavigateActions } from './autocomplete/types'
import { resetChat } from './autocomplete/chat-actions'
import { renderTimelineItem, isRenderable } from './renderers'

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
  onSetDisplayMode?: (target: TabDisplayMode) => void
  /** Cmd+Click on a URL → in-app slay browser. Cmd+Shift+Click always external. */
  onOpenUrl?: (url: string) => void
  /** Cmd+Click on a file:line:col reference → editor pane. */
  onOpenFile?: (filePath: string, options?: { position?: { line: number; col?: number } }) => void
}

const SUGGESTED_PROMPTS = [
  'Explain what this codebase does',
  'Find the entry point',
  'What are the main dependencies?',
]

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(props, ref) {
  const { tabId, taskId, mode, cwd, isActive = true, providerFlagsOverride, permissionNotice: overrideNotice, onSetDisplayMode, onOpenUrl, onOpenFile } = props
  const { state, timeline, inFlight, hydrating, permissionMode, permissionRequests, sendMessage, sendToolResult, respondPermission, abortAndPop, reset: resetTimeline } = useChatSession({
    tabId,
    taskId,
    mode,
    cwd,
    providerFlagsOverride,
  })

  const appearance = useAppearance()
  const widthClass = appearance.chatWidth === 'wide' ? 'max-w-none' : 'max-w-4xl'
  const composerWidthClass = appearance.chatWidth === 'wide' ? 'max-w-4xl' : 'max-w-2xl'


  const [draft, setDraft] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const { chatMode, handleModeChange, autoCapability } = useChatMode({
    taskId, mode, tabId, cwd, livePermissionMode: permissionMode,
  })
  const { chatModel, modelChanging, handleModelChange } = useChatModel({
    taskId, mode, tabId, cwd,
  })
  const { chatEffort, effortChanging, handleEffortChange } = useChatEffort({
    taskId, mode, tabId, cwd,
  })
  const [collapseSignal, setCollapseSignal] = useState(0)
  const finalOnly = !appearance.chatShowTools
  const showLastMessageTools = appearance.chatShowLastMessageTools
  // Forward-declared ref — wired to autocomplete.bumpUsageFromMessage further
  // down once the autocomplete hook has run. The drain callback closes over
  // this ref, so the assignment lands before the first onDrained fires.
  const bumpUsageRef = useRef<(text: string) => Promise<void> | void>(() => {})
  /**
   * "Up next" queue lives in SQLite (table `chat_queue`) — survives reload,
   * sync's across windows, drained main-side on session→idle. Hook is a
   * subscriber + thin RPC facade. `onDrained` fires after the main process
   * pops + dispatches; carry the raw `original` text into the autocomplete
   * usage hook so /-token tiebreak counts bump exactly as the pre-backend
   * implementation did.
   */
  const {
    items: queuedMessages,
    push: pushQueue,
    remove: removeQueue,
    clear: clearQueue,
  } = useChatQueue(tabId, (original) => {
    void bumpUsageRef.current(original)
  })
  const [attachments, setAttachments] = useState<ArtifactRef[]>([])
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useFollowBottom()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Snapshot of the in-flight turn's raw input + attachments. Used by Stop/Esc
  // to restore the chips + clean text (without inline image markdown) when the
  // main side pops the turn. Updated only on user submits that go straight to
  // the wire — queued submits don't overwrite it, so the snapshot stays aligned
  // with the in-flight turn even when a queue exists.
  const lastSentRef = useRef<{ text: string; attachments: ArtifactRef[] } | null>(null)

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }))

  // Auto-focus composer when this task tab becomes active (mount-while-active
  // or inactive→active transition). Tab content stays mounted with display:none
  // when inactive, so a mount-only autoFocus would miss tab switches.
  useEffect(() => {
    if (isActive) textareaRef.current?.focus()
  }, [isActive])

  const { uploadFiles: uploadImageFiles, getFilePath: getArtifactFilePath } = useArtifactUpload(taskId)

  const imagePasteDrop = useImagePasteDrop<ArtifactRef>({
    onUpload: uploadImageFiles,
    onInsert: (results) => {
      setAttachments((prev) => [...prev, ...results])
      textareaRef.current?.focus()
    },
    onError: (err) => toast(`Image upload failed: ${err instanceof Error ? err.message : String(err)}`),
  })

  const chatApi = useMemo<ChatActions>(() => {
    const api = (window as unknown as {
      api?: {
        chat?: {
          kill: (tabId: string) => Promise<void>
          remove: (tabId: string) => Promise<void>
          reset: (opts: {
            tabId: string
            taskId: string
            mode: string
            cwd: string
            providerFlagsOverride?: string | null
          }) => Promise<unknown>
          create: (opts: {
            tabId: string
            taskId: string
            mode: string
            cwd: string
            providerFlagsOverride?: string | null
          }) => Promise<unknown>
          send: (tabId: string, text: string) => Promise<boolean>
          interrupt: (opts: {
            tabId: string
            taskId: string
            mode: string
            cwd: string
            providerFlagsOverride?: string | null
          }) => Promise<unknown>
        }
      }
    }).api
    const chat = api?.chat
    return {
      kill: (id) => chat?.kill(id) ?? Promise.resolve(),
      remove: (id) => chat?.remove(id) ?? Promise.resolve(),
      reset: (opts) => chat?.reset(opts) ?? Promise.resolve(null),
      create: (opts) => chat?.create(opts) ?? Promise.resolve(null),
      send: (id, text) => chat?.send(id, text) ?? Promise.resolve(false),
      interrupt: (o) => chat?.interrupt(o) ?? Promise.resolve(null),
    }
  }, [])

  const navigate = useMemo<NavigateActions>(
    () => ({
      openSettings(tab) {
        window.dispatchEvent(new CustomEvent('open-settings', { detail: tab ?? 'appearance' }))
      },
      openExternal(url) {
        const api = (window as unknown as {
          api?: { shell?: { openExternal: (url: string) => Promise<unknown> } }
        }).api
        void api?.shell?.openExternal(url)
      },
      openFile(absPath) {
        const api = (window as unknown as {
          api?: { shell?: { openPath: (p: string) => Promise<string> } }
        }).api
        void api?.shell?.openPath(absPath)
      },
    }),
    []
  )

  const sources = useMemo(
    () => [
      createFilesSource(),
      createCommandsSource((text) => sendMessage(text).then(() => true)),
      createAgentsSource(),
      createBuiltinsSource(),
      createSkillsSource(),
    ],
    [sendMessage]
  ) as AutocompleteSource[]

  const autocomplete = useAutocomplete({
    sources,
    draft,
    setDraft,
    cursorPos,
    fetchCtx: { cwd },
    acceptCtx: {
      session: { tabId, taskId, mode, cwd, providerFlagsOverride: providerFlagsOverride ?? null },
      chat: chatApi,
      navigate,
      toast: (msg) => toast(msg),
    },
  })


  // When `finalOnly` is on, keep user msgs + result + the last assistant
  // text per turn. Drop thinking/tools/intermediate text/noise.
  // Always filter non-renderable items so virtualizer count matches visible DOM.
  // Also drop items with `parentToolUseId` set — those are sub-agent children,
  // rendered nested inside their parent SubAgentRow, not at the chat root.
  // When `showLastMessageTools` is on, tools after the last user message are
  // preserved so the user sees what the agent is doing right now.
  const displayedTimeline = useMemo<TimelineItem[]>(() => {
    const isRoot = (item: TimelineItem): boolean => item.parentToolUseId == null
    if (!finalOnly) return timeline.filter((item) => isRoot(item) && isRenderable(item))
    let lastUserIdx = -1
    if (showLastMessageTools) {
      for (let i = timeline.length - 1; i >= 0; i--) {
        if (isRoot(timeline[i]) && timeline[i].kind === 'user-text') {
          lastUserIdx = i
          break
        }
      }
    }
    const out: TimelineItem[] = []
    let pendingFinal: TimelineItem | null = null
    const flushPending = (): void => {
      if (pendingFinal) {
        out.push(pendingFinal)
        pendingFinal = null
      }
    }
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i]
      if (!isRoot(item)) continue
      if (item.kind === 'user-text') {
        flushPending()
        out.push(item)
      } else if (item.kind === 'text' && item.role === 'assistant') {
        pendingFinal = item
      } else if (item.kind === 'tool' && (item.invocation.name === 'ExitPlanMode' || item.invocation.name === 'AskUserQuestion')) {
        flushPending()
        out.push(item)
      } else if (item.kind === 'tool' && showLastMessageTools && i > lastUserIdx) {
        flushPending()
        out.push(item)
      } else if (item.kind === 'sub-agent' && showLastMessageTools && i > lastUserIdx) {
        flushPending()
        out.push(item)
      } else if (item.kind === 'thinking' && showLastMessageTools && i > lastUserIdx) {
        flushPending()
        out.push(item)
      } else if (item.kind === 'result') {
        flushPending()
        out.push(item)
      }
    }
    flushPending()
    return out.filter(isRenderable)
  }, [timeline, finalOnly, showLastMessageTools])

  const search = useChatSearch(displayedTimeline)

  // Paginate older items: show last `visibleCount`, expose "Show more" at top.
  const PAGE_SIZE = 100
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const hiddenCount = Math.max(0, displayedTimeline.length - visibleCount)
  const visibleStart = displayedTimeline.length - Math.min(visibleCount, displayedTimeline.length)
  const visibleItems = displayedTimeline.slice(visibleStart)

  // Auto-expand window if a search match lands above it.
  useEffect(() => {
    if (search.activeItemIdx < 0) return
    if (search.activeItemIdx < visibleStart) {
      setVisibleCount(displayedTimeline.length - search.activeItemIdx)
    }
  }, [search.activeItemIdx, visibleStart, displayedTimeline.length])

  // Stable per-item keys so streaming text updates re-render the same DOM node.
  const itemKey = useCallback((item: TimelineItem, index: number): Key => {
    if (item.kind === 'text' || item.kind === 'thinking') return `${item.kind}:${item.messageId}`
    if (item.kind === 'tool') return `tool:${item.invocation.id}`
    if (item.kind === 'session-start') return `session:${item.sessionId}`
    if (item.kind === 'result') return `result:${item.timestamp}:${index}`
    return `${item.kind}:${index}`
  }, [])


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
      sendMessage: (text: string) => { void sendMessage(text) },
      sendToolResult,
      permissionRequests,
      respondPermission,
      timeline,
      childIndex: state.childIndex,
      onOpenUrl,
      onOpenFile: handleOpenFile,
    }),
    [collapseSignal, finalOnly, appearance.chatFileEditsOpenByDefault, appearance.chatShowMessageMeta, search.query, search.caseSensitive, handleModeChange, sendMessage, sendToolResult, permissionRequests, respondPermission, timeline, state.childIndex, onOpenUrl, handleOpenFile],
  )

  // Autosize textarea. Height follows scrollHeight up to 240px; no artificial min —
  // an empty draft renders as a single-line input.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft])

  // Snap timeline to bottom when user starts composing — empty→non-empty edge.
  // Stick-to-bottom only auto-sticks when already at bottom; this forces re-stick
  // so the latest history is visible while typing.
  const wasDraftEmptyRef = useRef(true)
  useEffect(() => {
    const empty = draft.length === 0
    if (wasDraftEmptyRef.current && !empty) {
      void scrollToBottom()
    }
    wasDraftEmptyRef.current = empty
  }, [draft, scrollToBottom])

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (state.sessionEnded) return
    if (!text && attachments.length === 0) return

    // Builtin `/effort <level>` — write enum to provider_config; setEffort
    // handler kill+respawns. Mirrors the AgentEffortPill path; both UIs go
    // through the same canonical field, no flag-string mutation.
    const effortMatch = /^\/effort\s+(\S+)\s*$/.exec(text)
    if (effortMatch) {
      const raw = effortMatch[1].toLowerCase()
      const valid = ['low', 'medium', 'high', 'xhigh', 'max'] as const
      if (!(valid as readonly string[]).includes(raw)) {
        toast(`Invalid effort level "${raw}". Use: ${valid.join(', ')}`)
        return
      }
      setDraft('')
      await handleEffortChange(raw as typeof valid[number])
      toast(`Effort set to ${raw}`)
      return
    }

    // Allow sources (e.g. commands) to transform `/cmdname args` into expanded template.
    const transform = autocomplete.transformSubmit(text)
    let toSend = transform?.send ?? text

    // Materialize image attachments to abs filesystem paths and prepend to message.
    if (attachments.length > 0) {
      const resolved = await Promise.all(
        attachments.map(async (a) => {
          const p = await getArtifactFilePath(a.id)
          return { ref: a, path: p }
        })
      )
      const missing = resolved.filter((r) => r.path === null)
      if (missing.length > 0) {
        toast(`${missing.length} image${missing.length === 1 ? '' : 's'} no longer available — skipping`)
      }
      const imageRefs = resolved
        .filter((r): r is { ref: ArtifactRef; path: string } => r.path !== null)
        .map((r) => `![${r.ref.title}](${r.path})`)
        .join('\n')
      toSend = imageRefs + (toSend ? `\n\n${toSend}` : '')
    }

    // Capture raw input + attachments BEFORE clearing — used by Stop/Esc to
    // restore them if the turn is popped. Skip when queueing: lastSentRef must
    // remain aligned with the in-flight turn, not the queued one.
    const snapshot = { text, attachments: [...attachments] }
    setDraft('')
    setAttachments([])
    void scrollToBottom()
    if (!toSend) return
    // Queue when a turn is in flight OR a queue already exists (preserve FIFO
    // even after reload — the renderer's `inFlight` mirror could be `false`
    // while persisted queue items still need to flush in order). Backend
    // drainer pops on session→idle.
    if (inFlight || queuedMessages.length > 0) {
      await pushQueue(toSend, text)
      return
    }
    lastSentRef.current = snapshot
    await sendMessage(toSend)
    // Bump usage from the ORIGINAL `text` — slash tokens may not survive template
    // expansion. Only fires after sendMessage resolves (closest signal we have to
    // a successful send; sendMessage doesn't throw on failure). Read fn via ref
    // so we don't add `autocomplete` to deps — its returned object is a fresh
    // ref each render and would over-fire dependent effects.
    void bumpUsageRef.current(text)
  }, [draft, attachments, getArtifactFilePath, inFlight, queuedMessages.length, pushQueue, state.sessionEnded, sendMessage, autocomplete, chatApi, tabId, taskId, mode, cwd, providerFlagsOverride, scrollToBottom])

  // Wire the forward-declared bumpUsageRef now that autocomplete is in scope.
  // `autocomplete` is a fresh object every render (useAutocomplete returns
  // an object literal); reading via ref keeps the backend drain callback
  // stable so onDrained subscribers don't churn.
  bumpUsageRef.current = autocomplete.bumpUsageFromMessage

  // Stop button + Esc shared path. Clears the queue (intentional: queued msgs
  // are abandoned alongside the in-flight turn — the main side wipes
  // chat_queue inside chat:abortAndPop too, this client-side clear is a
  // belt-and-suspenders for instant UI feedback before the broadcast lands).
  // Aborts the turn on the main side and — if no progress had arrived —
  // restores the popped text + attachments to the composer for editing.
  // Skips restore when the user has already started typing again (draft
  // non-empty).
  const handleStop = useCallback(async () => {
    void clearQueue()
    const result = await abortAndPop()
    if (!result.popped) return
    if (draft.trim() !== '') return
    const snap = lastSentRef.current
    if (snap) {
      setDraft(snap.text)
      setAttachments(snap.attachments)
    } else if (result.text) {
      setDraft(result.text)
    }
    lastSentRef.current = null
    textareaRef.current?.focus()
  }, [abortAndPop, draft, clearQueue])

  // Clear queue on session end / reset.
  useEffect(() => {
    if (state.sessionEnded) void clearQueue()
  }, [state.sessionEnded, clearQueue])

  // Cmd+F / Ctrl+F opens search; Cmd+↑/↓ scrolls to top/bottom of the timeline.
  // Scoped to the panel that owns keyboard focus — multiple chat tabs stay
  // mounted (display:none) and a window-level listener would otherwise fire in
  // every panel simultaneously.
  useEffect(() => {
    const isFocusedHere = (): boolean => {
      const root = panelRef.current
      if (!root) return false
      const active = document.activeElement
      // Active element inside the panel? OR the panel itself has focus?
      // Also accept body-focus (no element focused) when the panel is the only
      // visible chat panel — heuristic: treat panel as "owner" when no other
      // chat panel sibling is currently focus-receiving.
      if (active && root.contains(active)) return true
      if (active === document.body) {
        // Find the closest visible ChatPanel ancestor of any input — if none,
        // and this panel is visible, claim ownership.
        const visibleSelf = root.offsetParent !== null
        if (!visibleSelf) return false
        const others = document.querySelectorAll('[data-chat-panel]')
        for (const o of Array.from(others)) {
          if (o === root) continue
          const el = o as HTMLElement
          if (el.offsetParent !== null) return false // another panel also visible — defer
        }
        return true
      }
      return false
    }
    const handler = (e: KeyboardEvent): void => {
      if (!isFocusedHere()) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        search.requestOpen()
        return
      }
      if (mod && e.key === 'ArrowUp') {
        e.preventDefault()
        scrollRef.current?.scrollTo({ top: 0 })
        return
      }
      if (mod && e.key === 'ArrowDown') {
        e.preventDefault()
        const el = scrollRef.current
        if (el) el.scrollTo({ top: el.scrollHeight })
        return
      }
      // Shift+Tab cycles agent permission mode whenever the chat panel owns
      // focus — terminal-mode parity. Skipped while a turn is in flight (mode
      // change kills + respawns the subprocess) or while autocomplete consumes
      // Tab to accept the current selection.
      if (e.key === 'Tab' && e.shiftKey && !mod && !e.altKey) {
        if (autocomplete.show) return
        e.preventDefault()
        if (inFlight) return
        const next = nextAgentMode(chatMode, autoCapability.optedIn)
        handleModeChange(next).catch(() => { /* toast already shown by hook */ })
      }
      // Esc stops the in-flight turn — Claude CLI parity. Defers to autocomplete
      // (which uses Esc to close itself). No-op when nothing is in flight.
      if (e.key === 'Escape' && !mod && !e.altKey && !e.shiftKey) {
        if (autocomplete.show) return
        if (!inFlight) return
        e.preventDefault()
        void handleStop()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [scrollRef, search, inFlight, chatMode, handleModeChange, autoCapability.optedIn, autocomplete.show, handleStop])

  // Diagnostic: log every inFlight transition (incl. baseline post-hydrate) with
  // the counters that drive `isInFlight` plus the last 5 timeline kinds. Captures
  // evidence next time the indicator gets stuck without forcing a repro.
  const prevInFlightRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (hydrating) return
    const prev = prevInFlightRef.current
    prevInFlightRef.current = inFlight
    if (prev === inFlight) return
    try {
      const api = (window as unknown as {
        api?: { diagnostics?: { recordClientEvent?: (e: {
          event: string; level: 'info' | 'warn'; message: string; taskId?: string; sessionId?: string | null; payload: unknown
        }) => void } }
      }).api
      api?.diagnostics?.recordClientEvent?.({
        event: 'renderer.chat.inFlight.flip',
        level: 'info',
        message: `inFlight ${prev ?? 'init'}→${inFlight}`,
        taskId,
        sessionId: state.sessionId,
        payload: {
          tabId,
          mode,
          from: prev,
          to: inFlight,
          userMessagesSent: state.userMessagesSent,
          resultCount: state.resultCount,
          sessionEnded: state.sessionEnded,
          timelineLen: state.timeline.length,
          lastEventKinds: state.timeline.slice(-5).map((it) => it.kind),
        },
      })
    } catch { /* diagnostics never escalate */ }
  }, [inFlight, hydrating, tabId, taskId, mode, state.sessionId, state.userMessagesSent, state.resultCount, state.sessionEnded, state.timeline])

  // Scroll to the active match.
  useEffect(() => {
    if (search.activeItemIdx < 0) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${search.activeItemIdx}"]`)
    el?.scrollIntoView({ block: 'center' })
  }, [search.activeItemIdx, scrollRef])

  const copyAllMessages = useCallback(() => {
    const text = displayedTimeline
      .map((it) => {
        switch (it.kind) {
          case 'user-text': return `> ${it.text}`
          case 'text': return it.text
          case 'thinking': return `[thinking] ${it.text}`
          case 'result': return it.text ?? ''
          case 'tool': return `[tool: ${it.invocation.name}]`
          default: return ''
        }
      })
      .filter(Boolean)
      .join('\n\n')
    void navigator.clipboard.writeText(text)
    toast('Conversation copied')
  }, [displayedTimeline])

  const copyLastResponse = useCallback(() => {
    const last = [...displayedTimeline].reverse().find((it) => it.kind === 'text')
    if (last && last.kind === 'text') {
      void navigator.clipboard.writeText(last.text)
      toast('Last response copied')
    } else {
      toast('No response to copy')
    }
  }, [displayedTimeline])


  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (autocomplete.handleKeyDown(e)) return
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        void handleSend()
      }
    },
    [handleSend, autocomplete]
  )

  const copySessionId = useCallback(() => {
    if (!state.sessionId) return
    void navigator.clipboard.writeText(state.sessionId)
  }, [state.sessionId])

  const [resetting, setResetting] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [pendingChatDisable, setPendingChatDisable] = useState(false)
  // Suppress "Session ended" UI during a reset/restart — process-exit fires between kill and
  // the new session's turn-init, creating a brief flash of the ended state.
  const displaySessionEnded = state.sessionEnded && !resetting && !restarting
  const handleRestart = useCallback(async () => {
    if (restarting) return
    setRestarting(true)
    try {
      await chatApi.create({
        tabId,
        taskId,
        mode,
        cwd,
        providerFlagsOverride: providerFlagsOverride ?? null,
      })
    } catch (err) {
      toast(`Restart failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestarting(false)
    }
  }, [restarting, chatApi, tabId, taskId, mode, cwd, providerFlagsOverride])
  const handleReset = useCallback(async () => {
    if (resetting) return
    setResetting(true)
    // Clear timeline + ended-state immediately so UI re-enables input while new session spawns.
    resetTimeline()
    setDraft('')
    void clearQueue()
    try {
      await resetChat(
        chatApi,
        { tabId, taskId, mode, cwd, providerFlagsOverride: providerFlagsOverride ?? null },
        {
          interruptFirst: inFlight,
          onSuccess: () => toast('Chat reset'),
          onError: (err) =>
            toast(`Reset failed: ${err instanceof Error ? err.message : String(err)}`),
        }
      )
    } catch {
      /* handled via onError */
    } finally {
      setResetting(false)
    }
  }, [resetting, inFlight, chatApi, tabId, taskId, mode, cwd, providerFlagsOverride, resetTimeline, clearQueue])

  const isEmpty = timeline.length === 0 || (timeline.length === 1 && timeline[0].kind === 'session-start')

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
        if (target.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"]')) return
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed) return
        textareaRef.current?.focus()
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
      {/* Header: mode pill + (override notice if explicitly passed by parent) */}
      {overrideNotice && (
        <div className="px-4 py-2 text-xs bg-amber-500/10 border-b border-amber-500/30 text-amber-800 dark:text-amber-300">
          {overrideNotice}
        </div>
      )}
      {/* Search bar — Cmd+F overlay */}
      {search.open && (
        <ChatSearchBar
          query={search.query}
          onQueryChange={search.setQuery}
          caseSensitive={search.caseSensitive}
          onCaseSensitiveChange={search.setCaseSensitive}
          resultCount={search.matchCount}
          resultIndex={search.activeIdx}
          onPrev={search.prev}
          onNext={search.next}
          onClose={search.close}
          focusToken={search.focusToken}
        />
      )}

      {state.bgShells.size > 0 && (
        <div className="pointer-events-none absolute top-6 right-6 z-20 flex flex-col gap-3">
          <div className="pointer-events-auto">
            <BackgroundJobsBanner
              floating={false}
              shells={state.bgShells}
              order={state.bgShellOrder}
            />
          </div>
        </div>
      )}

      {/* Timeline */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
      <div className="relative flex-1 min-h-0">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          <div ref={contentRef} className="min-h-full">
            {hydrating ? (
              <HydratingState />
            ) : isEmpty && !inFlight ? (
              <EmptyState
                onPick={(text) => {
                  void sendMessage(text)
                }}
              />
            ) : (
              <div className={cn('mx-auto w-full pt-4', widthClass)}>
                {hiddenCount > 0 && (
                  <div className="flex justify-center py-2">
                    <button
                      onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                      className="text-xs text-muted-foreground hover:text-foreground rounded-md px-3 py-1 border border-border/50 hover:bg-muted/60 transition-colors"
                    >
                      Show {Math.min(PAGE_SIZE, hiddenCount)} earlier
                      {hiddenCount > PAGE_SIZE ? ` (${hiddenCount} hidden)` : ''}
                    </button>
                  </div>
                )}
                {visibleItems.map((item, i) => {
                  const index = visibleStart + i
                  const rendered = renderTimelineItem(item, index)
                  if (rendered === null) return null
                  return (
                    <div key={itemKey(item, index)} data-index={index}>
                      {rendered}
                    </div>
                  )
                })}
                {inFlight && <TypingIndicator label={deriveLoadingLabel(state)} />}
              </div>
            )}
          </div>
        </div>

        {/* Jump-to-latest button */}
        {!isAtBottom && (
          <button
            onClick={() => void scrollToBottom()}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-background border border-border shadow-md text-xs hover:bg-muted transition-colors"
          >
            <ArrowDown className="size-3" />
            Jump to latest
          </button>
        )}
      </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={copyLastResponse}>Copy last response</ContextMenuItem>
          <ContextMenuItem onSelect={copyAllMessages}>Copy entire conversation</ContextMenuItem>
          {state.sessionId && (
            <ContextMenuItem onSelect={copySessionId}>
              Copy session id
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={search.requestOpen}>
            Find in chat… (⌘F)
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setCollapseSignal((n) => n + 1)}>
            Collapse all expanded blocks
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Width</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={appearance.chatWidth}
                onValueChange={(v) => {
                  getTrpcVanillaClient().settings.set.mutate({ key: 'chat_width', value: v })
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              >
                <ContextMenuRadioItem value="narrow">Narrow</ContextMenuRadioItem>
                <ContextMenuRadioItem value="wide">Wide</ContextMenuRadioItem>
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onSelect={() => { void handleReset() }} disabled={resetting}>
            Reset chat
          </ContextMenuItem>
          {onSetDisplayMode && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => setPendingChatDisable(true)}>
                Disable chat
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Composer */}
      <div className="bg-background px-4 pt-6 pb-1">
        <div className={cn('mx-auto w-full', composerWidthClass)}>
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <div className="px-1 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
              Up next · {queuedMessages.length}
            </div>
            <ul className="divide-y divide-border/40 rounded-md border border-border/40 overflow-hidden">
              {queuedMessages.map((msg, i) => (
                <li
                  key={msg.id}
                  className="group flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30"
                >
                  <span className="shrink-0 text-muted-foreground/50 font-mono text-[10px] tabular-nums">
                    {i + 1}.
                  </span>
                  <span className="flex-1 min-w-0 truncate">{msg.send}</span>
                  <button
                    onClick={() => void removeQueue(msg.id)}
                    className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-destructive/15 hover:text-destructive transition-colors"
                    aria-label="Cancel queued message"
                    title="Cancel"
                  >
                    <XIcon className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5 px-1">
            {attachments.map((a, i) => (
              <span
                key={`${a.id}-${i}`}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                title={a.title}
              >
                <span className="max-w-[160px] truncate">{a.title}</span>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  className="rounded p-0.5 hover:bg-destructive/15 hover:text-destructive transition-colors"
                  aria-label="Remove attachment"
                >
                  <XIcon className="size-2.5" />
                </button>
              </span>
            ))}
            {imagePasteDrop.isUploading && (
              <span className="text-[11px] text-muted-foreground/60">uploading…</span>
            )}
          </div>
        )}
        <div
          className={cn(
            'relative flex items-center gap-2 rounded-2xl bg-muted/40 ring-1 ring-border/60 px-3 py-1.5 transition-shadow',
            displaySessionEnded && 'opacity-50 pointer-events-none'
          )}
          onPaste={(e) => {
            const files = imagePasteDrop.extractImageFiles(e.clipboardData)
            if (files.length === 0) return
            e.preventDefault()
            void imagePasteDrop.handleFiles(files)
          }}
        >
          {autocomplete.show && autocomplete.active && (
            <AutocompleteMenu
              active={autocomplete.active}
              selectedIndex={autocomplete.selectedIndex}
              onSelect={(i) => {
                autocomplete.accept(i)
                textareaRef.current?.focus()
              }}
              onHover={autocomplete.setSelectedIndex}
            />
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setCursorPos(e.target.selectionStart ?? e.target.value.length)
            }}
            onSelect={(e) => {
              const el = e.currentTarget
              setCursorPos(el.selectionStart ?? el.value.length)
            }}
            onKeyUp={(e) => {
              const el = e.currentTarget
              setCursorPos(el.selectionStart ?? el.value.length)
            }}
            onKeyDown={onKeyDown}
            placeholder={displaySessionEnded ? 'Session ended' : 'Ask Claude anything…'}
            disabled={displaySessionEnded}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 max-h-[240px] py-0.5 leading-normal"
          />
          {inFlight ? (
            <button
              onClick={() => {
                void handleStop()
              }}
              disabled={displaySessionEnded}
              className="shrink-0 size-8 rounded-full flex items-center justify-center bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
              title="Stop generation (Esc)"
              aria-label="Stop generation"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => {
                void handleSend()
              }}
              disabled={(!draft.trim() && attachments.length === 0) || displaySessionEnded || imagePasteDrop.isUploading}
              className={cn(
                'shrink-0 size-8 rounded-full flex items-center justify-center transition-colors',
                (draft.trim() || attachments.length > 0) && !displaySessionEnded && !imagePasteDrop.isUploading
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed'
              )}
              title="Send (Enter)"
              aria-label="Send"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1.5 px-1 text-[10px] text-muted-foreground/60">
          {displaySessionEnded ? (
            <button
              type="button"
              onClick={() => { void handleRestart() }}
              disabled={restarting}
              className="text-destructive hover:underline disabled:opacity-50"
              title="Restart the chat session (preserves history)"
            >
              {restarting ? 'Restarting…' : 'Session ended, click to restart'}
            </button>
          ) : (
            <>
              <AgentModePill
                mode={chatMode}
                onChange={(next) => { handleModeChange(next).catch(() => { /* toast already shown by hook */ }) }}
                disabled={inFlight}
                compact
                variant="text"
                autoCapability={autoCapability}
              />
              {chatModel && (
                <AgentModelPill
                  model={chatModel}
                  onChange={(next) => { void handleModelChange(next) }}
                  disabled={modelChanging || inFlight}
                  compact
                  variant="text"
                />
              )}
              {chatModel && modelSupportsEffort(chatModel) && (
                <AgentEffortPill
                  effort={chatEffort}
                  onChange={(next) => { void handleEffortChange(next) }}
                  disabled={effortChanging || inFlight}
                  compact
                  variant="text"
                />
              )}
              {appearance.chatWidth === 'wide' && (
                <span>
                  {inFlight
                    ? 'Enter to queue · Shift+Enter for newline'
                    : 'Enter to send · Shift+Enter for newline'}
                </span>
              )}
            </>
          )}
          <div className="flex-1" />
          <Popover>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors',
                  finalOnly
                    ? 'bg-primary/15 text-foreground'
                    : 'hover:bg-muted/60 hover:text-foreground'
                )}
                title="Display options"
              >
                <Filter className="size-3" />
                Display
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-3 space-y-3">
              <DisplayOptionRow
                label="Show tools"
                description="Show all tool calls inline. When off, only user messages + final assistant reply per turn."
                checked={appearance.chatShowTools}
                onCheckedChange={(c) => {
                  getTrpcVanillaClient().settings.set.mutate({ key: 'chat_show_tools', value: c ? '1' : '0' })
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              />
              <DisplayOptionRow
                label="Show last message tools"
                description="When tools are hidden, still show tools after the most recent user message."
                checked={showLastMessageTools}
                disabled={appearance.chatShowTools}
                onCheckedChange={(c) => {
                  getTrpcVanillaClient().settings.set.mutate({ key: 'chat_show_last_message_tools', value: c ? '1' : '0' })
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              />
              <DisplayOptionRow
                label="File edits opened by default"
                description="Auto-expand Edit and Write tool cards."
                checked={appearance.chatFileEditsOpenByDefault}
                onCheckedChange={(c) => {
                  getTrpcVanillaClient().settings.set.mutate({ key: 'chat_file_edits_open_by_default', value: c ? '1' : '0' })
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              />
              <DisplayOptionRow
                label="Show message meta"
                description="Per-turn footer with duration, cost, and turn count."
                checked={appearance.chatShowMessageMeta}
                onCheckedChange={(c) => {
                  getTrpcVanillaClient().settings.set.mutate({ key: 'chat_show_message_meta', value: c ? '1' : '0' })
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              />
            </PopoverContent>
          </Popover>
          <button
            onClick={() => {
              void handleReset()
            }}
            disabled={resetting}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-50"
            title="Reset chat (kill session and start fresh)"
          >
            <RotateCcw className={cn('size-3', resetting && 'animate-spin')} />
            Reset
          </button>
        </div>
        </div>
      </div>

      <ConfirmDisplayModeDialog
        open={pendingChatDisable}
        target="xterm"
        onConfirm={() => {
          onSetDisplayMode?.('xterm')
          setPendingChatDisable(false)
        }}
        onCancel={() => setPendingChatDisable(false)}
      />
    </div>
    </ChatViewContext.Provider>
  )
})

function DisplayOptionRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (next: boolean) => void
}) {
  return (
    <div className={cn('flex items-start gap-3', disabled && 'opacity-50')}>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">{description}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} className="mt-0.5" />
    </div>
  )
}

function HydratingState() {
  return (
    <div className="h-full relative">
      <PulseGrid />
    </div>
  )
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="size-12 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white shadow-lg mb-4">
        <Sparkles className="size-5" />
      </div>
      <div className="text-base font-medium">Chat with Claude Code</div>
      <div className="text-sm text-muted-foreground mt-1 mb-6">
        Structured responses. Diffs, file reads, and tool calls rendered inline.
      </div>
      <div className="flex flex-col gap-1.5 w-full max-w-sm">
        {SUGGESTED_PROMPTS.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="text-left text-xs px-3 py-2 rounded-lg border border-border/60 hover:bg-muted/60 hover:border-border transition-colors"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

function TypingIndicator({ label }: { label?: string | null }) {
  return (
    <div className="px-4 py-2 flex gap-3 items-center">
      <div className="shrink-0 size-7 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white shadow-sm">
        <Sparkles className="size-3.5 animate-pulse" />
      </div>
      <div className="flex gap-1 px-3 py-2 rounded-2xl bg-muted/40">
        <span className="size-1.5 rounded-full bg-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="size-1.5 rounded-full bg-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="size-1.5 rounded-full bg-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      {label && (
        <span className="text-xs text-muted-foreground truncate max-w-[60ch]">{label}</span>
      )}
    </div>
  )
}
