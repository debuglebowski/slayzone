import { useRef, useState, type ReactNode } from 'react'
import { ArrowUp, MessageSquare, Plus, X } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import {
  cn,
  clampChatThreadsWidth,
  useAppearance,
  CHAT_THREADS_DEFAULT_WIDTH,
  CHAT_THREADS_MIN_WIDTH,
  CHAT_THREADS_MAX_WIDTH
} from '@slayzone/ui'
import type { ChatThread } from '@slayzone/terminal-contracts'
import { useTRPC } from '../trpc'

/** Room always left for the main conversation beside the panel, px. */
const MAIN_MIN_WIDTH = 320
const KEY_STEP = 16

export function ChatThreadsPanel({
  threads,
  activeId,
  creating,
  onSelect,
  onCreate,
  onClose,
  renderThread
}: {
  threads: ChatThread[]
  activeId: string | null
  creating: boolean
  onSelect: (id: string | null) => void
  onCreate: (text: string) => Promise<boolean>
  onClose: () => void
  renderThread: (thread: ChatThread, active: boolean) => ReactNode
}) {
  const [draft, setDraft] = useState('')
  const [visited, setVisited] = useState<ReadonlySet<string>>(
    () => new Set(activeId ? [activeId] : [])
  )
  if (activeId && !visited.has(activeId)) setVisited(new Set([...visited, activeId]))
  const trpc = useTRPC()
  const savedWidth = useAppearance().chatThreadsWidth
  // Local width while dragging and until the saved setting catches up.
  const [previewWidth, setPreviewWidth] = useState<number | null>(null)
  const [pendingWidth, setPendingWidth] = useState<number | null>(null)
  if (pendingWidth !== null && previewWidth === null && savedWidth === pendingWidth)
    setPendingWidth(null)
  const width = previewWidth ?? pendingWidth ?? savedWidth
  const { mutate: saveSetting } = useMutation({
    ...trpc.settings.set.mutationOptions(),
    onSuccess: () => window.dispatchEvent(new CustomEvent('sz:settings-changed')),
    onError: () => setPendingWidth(null)
  })
  const commitWidth = (next: number): void => {
    setPreviewWidth(null)
    setPendingWidth(next)
    saveSetting({ key: 'chat_threads_width', value: String(next) })
  }
  const send = (): void => {
    if (draft.trim() && !creating)
      void onCreate(draft).then((created) => {
        if (created) setDraft('')
      })
  }
  return (
    <aside
      aria-label="Answer threads"
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-background"
      style={{ width, maxWidth: `calc(100% - ${MAIN_MIN_WIDTH}px)` }}
    >
      <ThreadsResizeHandle width={width} onPreview={setPreviewWidth} onCommit={commitWidth} />
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div
          role="tablist"
          aria-label="Threads for this answer"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !threads.length)
              return
            e.preventDefault()
            const at = threads.findIndex((t) => t.id === activeId)
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? threads.length - 1
                  : (at + (e.key === 'ArrowRight' ? 1 : -1) + threads.length) % threads.length
            onSelect(threads[next].id)
            const id = threads[next].id
            requestAnimationFrame(() => document.getElementById(`thread-tab-${id}`)?.focus())
          }}
        >
          {threads.map((thread) => (
            <button
              key={thread.id}
              id={`thread-tab-${thread.id}`}
              role="tab"
              type="button"
              aria-selected={thread.id === activeId}
              tabIndex={thread.id === activeId ? 0 : -1}
              title={thread.title}
              onClick={() => onSelect(thread.id)}
              className={cn(
                'h-7 max-w-36 shrink-0 truncate rounded border border-transparent px-2 text-xs text-muted-foreground hover:bg-muted/60',
                thread.id === activeId && 'border-border bg-surface-2 text-foreground'
              )}
            >
              {thread.title}
            </button>
          ))}
          {activeId === null && (
            <span className="flex h-7 items-center whitespace-nowrap rounded border border-border bg-surface-2 px-2 text-xs">
              New thread
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="New thread"
          title="New thread"
          onClick={() => onSelect(null)}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Close threads"
          onClick={onClose}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60"
        >
          <X className="size-3.5" />
        </button>
      </header>
      {threads
        .filter((thread) => visited.has(thread.id) || thread.id === activeId)
        .map((thread) => (
          <div
            key={thread.id}
            role="tabpanel"
            aria-labelledby={`thread-tab-${thread.id}`}
            className="min-h-0 flex-1"
            style={{ display: thread.id === activeId ? 'flex' : 'none' }}
          >
            {renderThread(thread, thread.id === activeId)}
          </div>
        ))}
      {activeId === null && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            <MessageSquare className="size-5" />
            <span className="text-sm text-foreground">Start a thread</span>
            <span>Ask a follow-up about this answer.</span>
          </div>
          <div className="px-4 pb-4 pt-3">
            <div className="flex items-center gap-2 rounded-2xl bg-muted/40 px-3 py-1.5 ring-1 ring-border/60">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
                disabled={creating}
                aria-label="First thread question"
                placeholder="Reply in thread…"
                rows={1}
                className="min-w-0 flex-1 resize-none bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground/60"
              />
              <button
                type="button"
                aria-label="Start thread"
                disabled={!draft.trim() || creating}
                onClick={send}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:bg-muted disabled:text-muted-foreground"
              >
                <ArrowUp className="size-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

/**
 * Left-edge divider of the threads panel. Dragging left widens the panel.
 * Pointer capture keeps the drag alive over the nested chat; arrows nudge;
 * double-click resets to the default width.
 */
function ThreadsResizeHandle({
  width,
  onPreview,
  onCommit
}: {
  width: number
  onPreview: (width: number | null) => void
  onCommit: (width: number) => void
}) {
  const drag = useRef<{ startX: number; startWidth: number; max: number; last: number } | null>(
    null
  )
  const maxFor = (el: HTMLElement): number => {
    const container = el.parentElement?.parentElement?.clientWidth ?? 0
    return Math.max(
      CHAT_THREADS_MIN_WIDTH,
      Math.min(CHAT_THREADS_MAX_WIDTH, container - MAIN_MIN_WIDTH)
    )
  }
  const fit = (value: number, max: number): number => Math.min(max, clampChatThreadsWidth(value))
  return (
    <div
      role="separator"
      aria-label="Resize threads"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={CHAT_THREADS_MIN_WIDTH}
      aria-valuemax={CHAT_THREADS_MAX_WIDTH}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className="absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize touch-none select-none outline-none transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 active:bg-primary/30"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        const startWidth = e.currentTarget.parentElement?.getBoundingClientRect().width ?? width
        drag.current = {
          startX: e.clientX,
          startWidth,
          max: maxFor(e.currentTarget),
          last: startWidth
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        d.last = fit(d.startWidth + (d.startX - e.clientX), d.max)
        onPreview(d.last)
      }}
      onPointerUp={(e) => {
        const d = drag.current
        if (!d) return
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        if (Math.round(d.last) === Math.round(d.startWidth)) onPreview(null)
        else onCommit(d.last)
      }}
      onPointerCancel={() => {
        drag.current = null
        onPreview(null)
      }}
      onDoubleClick={() => onCommit(CHAT_THREADS_DEFAULT_WIDTH)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const current = e.currentTarget.parentElement?.getBoundingClientRect().width ?? width
        const delta = e.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP
        onCommit(fit(current + delta, maxFor(e.currentTarget)))
      }}
    />
  )
}
