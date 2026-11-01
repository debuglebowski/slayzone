import { useContext, useRef, useState } from 'react'
import { Copy, MessageSquare, MoreHorizontal, Quote, ChevronRight } from 'lucide-react'
import {
  cn,
  useAppearance,
  safeClipboardWriteText,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  type AppearanceSettings
} from '@slayzone/ui'
import type { TimelineItem } from '@slayzone/terminal/client'
import { LiveBlockStoreContext, streamKeyOf } from '@slayzone/terminal/client'
import { AssistantMessageBody } from './renderers'
import { ActivityTurn } from './ActivityTurn'
import type { ActivityTurn as ActivityTurnData } from './activity-view'
import { MessageDetails } from './MessageDetails'
import { useChatView } from './ChatViewContext'

export function AssistantAnswer({
  item,
  turn,
  appearance,
  rowOf
}: {
  item: Extract<TimelineItem, { kind: 'text' }>
  turn?: ActivityTurnData
  appearance?: Pick<
    AppearanceSettings,
    | 'chatShowActivities'
    | 'chatPreviewLatestActivity'
    | 'chatShowActivityMessages'
    | 'chatShowThinking'
    | 'chatShowActivityTools'
  >
  rowOf?: (item: TimelineItem) => number | undefined
}) {
  const { quoteReply, threads } = useChatView()
  const liveStore = useContext(LiveBlockStoreContext)
  // Read on click rather than subscribing the toolbar to every stream delta.
  const answerMarkdown = (): string => {
    const key = item.stream === 'open' ? streamKeyOf(item) : undefined
    return (key ? liveStore?.get(key)?.text : undefined) ?? item.text
  }
  const compact = useAppearance().chatCompactSpacing
  const answerId = `${item.messageId}:${item.blockOrdinal ?? 0}`
  const discussions =
    threads?.threads.filter(
      (thread) =>
        thread.answerId === answerId &&
        (!turn?.userMessageId || thread.sourceMessageId === turn.userMessageId)
    ) ?? []
  const [menuOpen, setMenuOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const actionClass =
    'flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring'
  return (
    <div
      className={cn(
        'group/answer relative rounded-md transition-colors hover:bg-muted/50 focus-within:bg-muted/50',
        compact ? '-mx-0.5 p-0.5' : '-mx-5 p-5',
        menuOpen && 'bg-muted/50'
      )}
      data-testid="chat-assistant-answer"
    >
      <div
        className={cn(
          'absolute -top-2.5 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm opacity-0 pointer-events-none transition-opacity group-hover/answer:opacity-100 group-hover/answer:pointer-events-auto group-focus-within/answer:opacity-100 group-focus-within/answer:pointer-events-auto',
          compact ? 'right-0.5' : 'right-5',
          menuOpen && 'opacity-100 pointer-events-auto'
        )}
        role="toolbar"
        aria-label="Answer actions"
      >
        <button
          type="button"
          className={actionClass}
          aria-label="Copy response"
          title="Copy response"
          onClick={() => {
            void safeClipboardWriteText(bodyRef.current?.innerText ?? answerMarkdown())
          }}
        >
          <Copy className="size-3.5" />
        </button>
        {threads && turn?.userMessageId && item.stream !== 'open' && (
          <button
            type="button"
            className={actionClass}
            aria-label="Start thread"
            title="Start thread"
            onClick={() => threads.start(answerId, turn.userMessageId!)}
          >
            <MessageSquare className="size-3.5" />
          </button>
        )}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={actionClass}
              aria-label="More answer actions"
              title="More answer actions"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem
              onSelect={() => {
                void safeClipboardWriteText(bodyRef.current?.innerText ?? answerMarkdown())
              }}
            >
              <Copy className="size-3.5" />
              Copy response
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void safeClipboardWriteText(answerMarkdown())
              }}
            >
              <Copy className="size-3.5" />
              Copy as Markdown
            </DropdownMenuItem>
            {quoteReply && (
              <DropdownMenuItem onSelect={() => quoteReply(answerMarkdown())}>
                <Quote className="size-3.5" />
                Quote in main chat
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 max-w-full">
          <div ref={bodyRef} className="min-w-0">
            <AssistantMessageBody item={item} />
          </div>
          {turn && (
            <div
              className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 empty:hidden"
              data-testid="chat-answer-footer"
            >
              {appearance && (
                <ActivityTurn turn={turn} appearance={appearance} rowOf={rowOf} embedded />
              )}
              {discussions.length > 0 && (
                <button
                  type="button"
                  onClick={() => threads?.open(discussions[0])}
                  className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-3 py-1.5 text-xs text-muted-foreground shadow-sm hover:bg-muted/50"
                >
                  <MessageSquare className="size-3" />
                  <span className="font-medium text-foreground">Threads</span>
                  <span>
                    {discussions.length} {discussions.length === 1 ? 'item' : 'items'}
                  </span>
                  <ChevronRight className="size-3" />
                </button>
              )}
              {turn.result && <MessageDetails item={turn.result} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
