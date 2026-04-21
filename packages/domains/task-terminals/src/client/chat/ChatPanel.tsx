import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowUp,
  Square,
  Copy,
  Check,
  X as XIcon,
  Sparkles,
  ArrowDown,
  RotateCcw,
  ChevronsDownUp,
  Filter,
} from 'lucide-react'
import { ChatViewContext } from './ChatViewContext'
import { cn, toast } from '@slayzone/ui'
import { ConfirmDisplayModeDialog } from '../ConfirmDisplayModeDialog'
import type { TabDisplayMode } from '../../shared/types'
import { useChatSession, PulseGrid, type TimelineItem } from '@slayzone/terminal/client'
import { AutocompleteMenu } from './autocomplete/AutocompleteMenu'
import { useAutocomplete } from './autocomplete/useAutocomplete'
import { createSkillsSource } from './autocomplete/sources/skills'
import { createCommandsSource } from './autocomplete/sources/commands'
import { createAgentsSource } from './autocomplete/sources/agents'
import { createBuiltinsSource } from './autocomplete/sources/builtins'
import { createFilesSource } from './autocomplete/sources/files'
import type { AutocompleteSource, ChatActions, NavigateActions } from './autocomplete/types'
import { resetChat } from './autocomplete/chat-actions'
import { mergeEffortFlag } from './autocomplete/flags'
import {
  UserMessage,
  AssistantText,
  ThinkingBlock,
  SystemInit,
  ResultFooter,
  ApiRetryBanner,
  StderrBlock,
  UnknownBlock,
  renderTool,
} from './renderers'

export interface ChatPanelProps {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  providerFlagsOverride?: string | null
  permissionNotice?: string | null
  onSetDisplayMode?: (target: TabDisplayMode) => void
}

function renderTimelineItem(item: TimelineItem, key: React.Key): React.JSX.Element | null {
  switch (item.kind) {
    case 'user-text':
      return <UserMessage key={key} item={item} />
    case 'text':
      return <AssistantText key={key} item={item} />
    case 'thinking':
      return <ThinkingBlock key={key} item={item} />
    case 'tool':
      return <div key={key}>{renderTool(item.invocation)}</div>
    case 'session-start':
      return <SystemInit key={key} item={item} />
    case 'result':
      return <ResultFooter key={key} item={item} />
    case 'api-retry':
      return <ApiRetryBanner key={key} item={item} />
    case 'rate-limit':
      return item.status === 'allowed' ? null : (
        <div key={key} className="mx-4 my-1 text-[11px] text-amber-600">
          rate limit: {item.status}
        </div>
      )
    case 'sub-agent':
      return (
        <div key={key} className="mx-4 my-1 text-[11px] text-muted-foreground/70">
          sub-agent: {item.phase}
        </div>
      )
    case 'stderr':
      return <StderrBlock key={key} item={item} />
    case 'unknown':
      return <UnknownBlock key={key} item={item} />
  }
}

const SUGGESTED_PROMPTS = [
  'Explain what this codebase does',
  'Find the entry point',
  'What are the main dependencies?',
]

export function ChatPanel(props: ChatPanelProps) {
  const { tabId, taskId, mode, cwd, providerFlagsOverride, permissionNotice: overrideNotice, onSetDisplayMode } = props
  const { state, timeline, inFlight, hydrating, sendMessage, interrupt, reset: resetTimeline } = useChatSession({
    tabId,
    taskId,
    mode,
    cwd,
    providerFlagsOverride,
  })

  const [draft, setDraft] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [sessionIdCopied, setSessionIdCopied] = useState(false)
  const [permissionNotice, setPermissionNotice] = useState<string | null>(overrideNotice ?? null)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [collapseSignal, setCollapseSignal] = useState(0)
  const [finalOnly, setFinalOnly] = useState(false)
  const [queuedMessages, setQueuedMessages] = useState<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const chatApi = useMemo<ChatActions>(() => {
    const api = (window as unknown as {
      api?: {
        chat?: {
          kill: (tabId: string) => Promise<void>
          remove: (tabId: string) => Promise<void>
          create: (opts: {
            tabId: string
            taskId: string
            mode: string
            cwd: string
            providerFlagsOverride?: string | null
          }) => Promise<unknown>
          send: (tabId: string, text: string) => Promise<boolean>
          interrupt: (tabId: string) => Promise<void>
        }
      }
    }).api
    const chat = api?.chat
    return {
      kill: (id) => chat?.kill(id) ?? Promise.resolve(),
      remove: (id) => chat?.remove(id) ?? Promise.resolve(),
      create: (opts) => chat?.create(opts) ?? Promise.resolve(null),
      send: (id, text) => chat?.send(id, text) ?? Promise.resolve(false),
      interrupt: (id) => chat?.interrupt(id) ?? Promise.resolve(),
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

  useEffect(() => {
    if (overrideNotice !== undefined) {
      setPermissionNotice(overrideNotice)
      return
    }
    let cancelled = false
    const api = (
      window as unknown as {
        api: {
          chat: {
            inspectPermissions: (
              t: string,
              m: string
            ) => Promise<{ ok: boolean; hasSkipPerms: boolean; permissionModeValue: string | null }>
          }
        }
      }
    ).api
    void api.chat
      .inspectPermissions(taskId, mode)
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setPermissionNotice(
            'Tool calls may fail: no non-interactive permission mode set. Add --allow-dangerously-skip-permissions or --permission-mode acceptEdits.'
          )
        } else {
          setPermissionNotice(null)
        }
      })
      .catch(() => {
        /* ignore */
      })
    return () => {
      cancelled = true
    }
  }, [taskId, mode, overrideNotice])

  // When `finalOnly` is on, keep user msgs + session-start + result + the last assistant
  // text per turn. Drop thinking/tools/intermediate text/noise.
  const displayedTimeline = useMemo<TimelineItem[]>(() => {
    if (!finalOnly) return timeline
    const out: TimelineItem[] = []
    // Track the most recent assistant-text index per turn, flushed on result or next user.
    let pendingFinal: TimelineItem | null = null
    const flushPending = (): void => {
      if (pendingFinal) {
        out.push(pendingFinal)
        pendingFinal = null
      }
    }
    for (const item of timeline) {
      if (item.kind === 'user-text') {
        flushPending()
        out.push(item)
      } else if (item.kind === 'session-start') {
        out.push(item)
      } else if (item.kind === 'text' && item.role === 'assistant') {
        pendingFinal = item
      } else if (item.kind === 'result') {
        flushPending()
        out.push(item)
      }
    }
    flushPending()
    return out
  }, [timeline, finalOnly])

  const virtualizer = useVirtualizer({
    count: displayedTimeline.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (index) => {
      const item = displayedTimeline[index]
      if (!item) return index
      // Stable per-item keys so streaming text updates re-measure the same DOM node.
      if (item.kind === 'text' || item.kind === 'thinking') return `${item.kind}:${item.messageId}`
      if (item.kind === 'tool') return `tool:${item.invocation.id}`
      if (item.kind === 'session-start') return `session:${item.sessionId}`
      if (item.kind === 'result') return `result:${item.timestamp}`
      return `${item.kind}:${index}`
    },
  })


  const chatView = useMemo(() => ({ collapseSignal, finalOnly }), [collapseSignal, finalOnly])

  // Track scroll position to show/hide "jump to latest".
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = (): void => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setIsAtBottom(distanceFromBottom < 80)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll to bottom when at bottom.
  useEffect(() => {
    if (!isAtBottom) return
    const el = listRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [displayedTimeline.length, isAtBottom, inFlight])

  // Autosize textarea. Height follows scrollHeight up to 240px; no artificial min —
  // an empty draft renders as a single-line input.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft])

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (!text || state.sessionEnded) return

    // Builtin `/effort <level>` — update session flags + restart. Doesn't send to chat.
    const effortMatch = /^\/effort\s+(\S+)\s*$/.exec(text)
    if (effortMatch) {
      const level = effortMatch[1].toLowerCase()
      const valid = ['low', 'medium', 'high', 'xhigh', 'max']
      if (!valid.includes(level)) {
        toast(`Invalid effort level "${level}". Use: ${valid.join(', ')}`)
        return
      }
      setDraft('')
      const nextFlags = mergeEffortFlag(providerFlagsOverride ?? null, level)
      await resetChat(
        chatApi,
        { tabId, taskId, mode, cwd, providerFlagsOverride: nextFlags },
        {
          interruptFirst: inFlight,
          onSuccess: () => toast(`Effort set to ${level}`),
          onError: (err) =>
            toast(`Effort change failed: ${err instanceof Error ? err.message : String(err)}`),
        }
      ).catch(() => {
        /* handled via onError */
      })
      return
    }

    // Allow sources (e.g. commands) to transform `/cmdname args` into expanded template.
    const transform = autocomplete.transformSubmit(text)
    const toSend = transform?.send ?? text
    setDraft('')
    if (!toSend) return
    // If a turn is in flight, queue for later. Drain effect flushes when inFlight drops.
    if (inFlight) {
      setQueuedMessages((q) => [...q, toSend])
      return
    }
    await sendMessage(toSend)
  }, [draft, inFlight, state.sessionEnded, sendMessage, autocomplete, chatApi, tabId, taskId, mode, cwd, providerFlagsOverride])

  // Drain queue: when the active turn finishes, send the next queued message.
  useEffect(() => {
    if (inFlight) return
    if (queuedMessages.length === 0) return
    if (state.sessionEnded) return
    const [next, ...rest] = queuedMessages
    setQueuedMessages(rest)
    void sendMessage(next)
  }, [inFlight, queuedMessages, sendMessage, state.sessionEnded])

  // Clear queue on session end / reset.
  useEffect(() => {
    if (state.sessionEnded) setQueuedMessages([])
  }, [state.sessionEnded])

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
    setSessionIdCopied(true)
    setTimeout(() => setSessionIdCopied(false), 1500)
  }, [state.sessionId])

  const [resetting, setResetting] = useState(false)
  const [pendingChatDisable, setPendingChatDisable] = useState(false)
  // Suppress "Session ended" UI during a reset — process-exit fires between kill and
  // the new session's turn-init, creating a brief flash of the ended state.
  const displaySessionEnded = state.sessionEnded && !resetting
  const handleReset = useCallback(async () => {
    if (resetting) return
    setResetting(true)
    // Clear timeline + ended-state immediately so UI re-enables input while new session spawns.
    resetTimeline()
    setDraft('')
    setQueuedMessages([])
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
  }, [resetting, inFlight, chatApi, tabId, taskId, mode, cwd, providerFlagsOverride, resetTimeline])

  const scrollToBottom = useCallback(() => {
    const el = listRef.current
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [])

  const items = virtualizer.getVirtualItems()
  const isEmpty = timeline.length === 0 || (timeline.length === 1 && timeline[0].kind === 'session-start')

  return (
    <ChatViewContext.Provider value={chatView}>
    <div className="flex flex-col h-full bg-background">
      {/* Permission warning */}
      {permissionNotice && !noticeDismissed && (
        <div className="px-4 py-2 text-xs bg-amber-500/10 border-b border-amber-500/30 text-amber-800 dark:text-amber-300 flex items-start gap-2">
          <span className="flex-1">{permissionNotice}</span>
          <button
            onClick={() => setNoticeDismissed(true)}
            className="shrink-0 opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      )}

      {/* Timeline */}
      <div className="relative flex-1 min-h-0">
        <div ref={listRef} className="h-full overflow-y-auto pt-4">
          {hydrating ? (
            <HydratingState />
          ) : isEmpty && !inFlight ? (
            <EmptyState
              onPick={(text) => {
                void sendMessage(text)
              }}
            />
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map((v) => {
                const item = displayedTimeline[v.index]
                const rendered = renderTimelineItem(item, v.index)
                if (rendered === null) return null
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${v.start}px)`,
                    }}
                  >
                    {rendered}
                  </div>
                )
              })}
            </div>
          )}
          {inFlight && <TypingIndicator />}
        </div>

        {/* Jump-to-latest button */}
        {!isAtBottom && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-background border border-border shadow-md text-xs hover:bg-muted transition-colors"
          >
            <ArrowDown className="size-3" />
            Jump to latest
          </button>
        )}
      </div>

      {/* Composer */}
      <div className="bg-background px-4 pt-3 pb-1">
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <div className="px-1 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
              Up next · {queuedMessages.length}
            </div>
            <ul className="divide-y divide-border/40 rounded-md border border-border/40 overflow-hidden">
              {queuedMessages.map((msg, i) => (
                <li
                  key={i}
                  className="group flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30"
                >
                  <span className="shrink-0 text-muted-foreground/50 font-mono text-[10px] tabular-nums">
                    {i + 1}.
                  </span>
                  <span className="flex-1 min-w-0 truncate">{msg}</span>
                  <button
                    onClick={() =>
                      setQueuedMessages((q) => q.filter((_, idx) => idx !== i))
                    }
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
        <div
          className={cn(
            'relative flex items-center gap-2 rounded-2xl bg-muted/40 ring-1 ring-border/60 px-3 py-1.5 transition-shadow',
            'focus-within:ring-2 focus-within:ring-primary/40 focus-within:bg-background',
            displaySessionEnded && 'opacity-50 pointer-events-none'
          )}
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
                void interrupt()
              }}
              disabled={displaySessionEnded}
              className="shrink-0 size-8 rounded-full flex items-center justify-center bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
              title="Stop generation"
              aria-label="Stop generation"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => {
                void handleSend()
              }}
              disabled={!draft.trim() || displaySessionEnded}
              className={cn(
                'shrink-0 size-8 rounded-full flex items-center justify-center transition-colors',
                draft.trim() && !displaySessionEnded
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
          <span>
            {inFlight
              ? 'Enter to queue · Shift+Enter for newline'
              : 'Enter to send · Shift+Enter for newline'}
          </span>
          <div className="flex-1" />
          {state.sessionId && (
            <button
              onClick={copySessionId}
              className="flex items-center gap-1 hover:text-foreground"
              title="Copy session id"
            >
              <span className="font-mono">{state.sessionId.slice(0, 8)}</span>
              {sessionIdCopied ? <Check className="size-3" /> : <Copy className="size-3 opacity-60" />}
            </button>
          )}
          {displaySessionEnded && <span className="text-destructive">Session ended</span>}
          <button
            onClick={() => setCollapseSignal((n) => n + 1)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-muted/60 hover:text-foreground transition-colors"
            title="Collapse all expanded blocks"
          >
            <ChevronsDownUp className="size-3" />
            Collapse
          </button>
          <button
            onClick={() => setFinalOnly((v) => !v)}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors',
              finalOnly
                ? 'bg-primary/15 text-foreground'
                : 'hover:bg-muted/60 hover:text-foreground'
            )}
            title={finalOnly ? 'Show all messages' : 'Show only final replies'}
            aria-pressed={finalOnly}
          >
            <Filter className="size-3" />
            {finalOnly ? 'Showing final' : 'Final only'}
          </button>
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
          {onSetDisplayMode && (
            <button
              onClick={() => setPendingChatDisable(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-muted/60 hover:text-foreground transition-colors"
              title="Disable chat view — switch back to terminal"
            >
              Disable chat
            </button>
          )}
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

function TypingIndicator() {
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
    </div>
  )
}
