import { useContext, useRef, useState } from 'react'
import {
  Copy,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Quote,
  ChevronRight
} from 'lucide-react'
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
import { AssistantMessageBody, InterruptedBlock } from './renderers'
import { ActivityTurn } from './ActivityTurn'
import { TurnTriggerRow } from './TurnTriggerRow'
import type { ActivityTurn as ActivityTurnData } from './activity-view'
import { MessageDetails } from './MessageDetails'
import { TurnFooter } from './turn-footer'
import { turnBlockClass } from './chat-layout'
import { useChatView } from './ChatViewContext'
import { PinnedMark, PinToggleButton, usePinnedRow } from './PinnedMessageControls'

export function AssistantAnswer({
  item,
  turn,
  appearance,
  rowOf
}: {
  item: Extract<TimelineItem, { kind: 'text' | 'interrupted' }>
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
  const { quoteReply, threads, conversation } = useChatView()
  const liveStore = useContext(LiveBlockStoreContext)
  const answer = item.kind === 'text' ? item : null
  const hasResponse =
    answer !== null ||
    turn?.items.some((entry) => entry.kind === 'text' && entry.text.trim()) === true
  // Read on click rather than subscribing the toolbar to every stream delta.
  const answerMarkdown = (): string => {
    if (!answer) {
      return (turn?.items ?? [])
        .filter((entry) => entry.kind === 'text')
        .map((entry) => entry.text)
        .join('\n\n')
    }
    const key = answer.stream === 'open' ? streamKeyOf(answer) : undefined
    return (key ? liveStore?.get(key)?.text : undefined) ?? answer.text
  }
  const copyResponse = (): string =>
    (answer ? bodyRef.current?.innerText : undefined) ?? answerMarkdown()
  const compact = useAppearance().chatCompactSpacing
  const answerId = answer ? `${answer.messageId}:${answer.blockOrdinal ?? 0}` : null
  const discussions =
    threads?.threads.filter(
      (thread) =>
        thread.answerId === answerId &&
        (!turn?.userMessageId || thread.sourceMessageId === turn.userMessageId)
    ) ?? []
  const forkMessageId =
    conversation?.canFork &&
    turn?.userMessageId &&
    conversation.activeIds.has(turn.userMessageId) &&
    (!answer || (answer.stream !== 'open' && answer.parentToolUseId == null))
      ? turn.userMessageId
      : null
  const [menuOpen, setMenuOpen] = useState(false)
  // Only a finished answer pins (`pinnableRow`); an interrupted turn has none.
  const pin = usePinnedRow(item)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const actionClass =
    'flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring'
  return (
    <div
      className={cn(turnBlockClass(compact), menuOpen && 'bg-muted/50')}
      data-testid="chat-assistant-answer"
    >
      {/* The pin's mark where the toolbar shows on hover (the toolbar has its toggle). */}
      <PinnedMark
        item={item}
        className={cn(
          'absolute -top-2.5 z-10 bg-card transition-opacity group-hover/turn:opacity-0 group-focus-within/turn:opacity-0',
          compact ? 'right-0.5' : 'right-5',
          menuOpen && 'opacity-0'
        )}
      />
      <div
        className={cn(
          'absolute -top-2.5 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm opacity-0 pointer-events-none transition-opacity group-hover/turn:opacity-100 group-hover/turn:pointer-events-auto group-focus-within/turn:opacity-100 group-focus-within/turn:pointer-events-auto',
          compact ? 'right-0.5' : 'right-5',
          menuOpen && 'opacity-100 pointer-events-auto'
        )}
        role="toolbar"
        aria-label="Answer actions"
      >
        {hasResponse && (
          <button
            type="button"
            className={actionClass}
            aria-label="Copy response"
            title="Copy response"
            onClick={() => {
              void safeClipboardWriteText(copyResponse())
            }}
          >
            <Copy className="size-3.5" />
          </button>
        )}
        <PinToggleButton item={item} className="size-7" />
        {threads && answerId && turn?.userMessageId && answer?.stream !== 'open' && (
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
        {forkMessageId && conversation && (
          <button
            type="button"
            className={actionClass}
            aria-label="Fork from here"
            title="Fork from here"
            disabled={conversation.busy}
            onClick={() =>
              conversation.begin('fork', { id: forkMessageId, text: answerMarkdown() })
            }
          >
            <GitBranch className="size-3.5" />
          </button>
        )}
        {hasResponse && (
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
                  void safeClipboardWriteText(copyResponse())
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
              {pin && (
                <DropdownMenuItem onSelect={pin.toggle}>
                  <Pin className="size-3.5" />
                  {pin.pinned ? 'Unpin message' : 'Pin message'}
                </DropdownMenuItem>
              )}
              {quoteReply && (
                <DropdownMenuItem onSelect={() => quoteReply(answerMarkdown())}>
                  <Quote className="size-3.5" />
                  Quote in main chat
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {turn?.trigger && <TurnTriggerRow item={turn.trigger} />}
      <div className="flex items-start gap-3">
        <div className="min-w-0 max-w-full">
          <div ref={bodyRef} className="min-w-0">
            {item.kind === 'interrupted' ? (
              <InterruptedBlock item={item} />
            ) : (
              <AssistantMessageBody item={item} />
            )}
          </div>
          {turn && (
            <TurnFooter
              className={cn(
                'items-center gap-x-3 gap-y-2 py-2 -mb-2',
                menuOpen && 'before:bg-muted/50'
              )}
              panelsClassName="gap-y-2 pt-2"
              testId="chat-answer-footer"
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
            </TurnFooter>
          )}
        </div>
      </div>
    </div>
  )
}
