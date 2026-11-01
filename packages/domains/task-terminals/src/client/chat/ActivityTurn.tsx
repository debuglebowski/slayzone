import { useContext, useEffect, useId, useState } from 'react'
import { Brain, ChevronRight, MessageSquare, Sparkles, Wrench } from 'lucide-react'
import { cn, type AppearanceSettings } from '@slayzone/ui'
import { GhMarkdown } from '@slayzone/markdown/client'
import { streamKeyOf, useLiveBlock } from '@slayzone/terminal/client'
import type { ActivityItem, ActivityTurn as ActivityTurnData } from './activity-view'
import { HighlightedText } from './HighlightedText'
import { renderTimelineItem } from './renderers'
import { TimelineRowIndexContext, TimelineRowKeyContext, useRowUiState } from './row-ui-state'
import { ToolInActivityContext } from './tool-cards/card-shell'
import { ToolFocusContext } from './tool-cards/tool-focus'
import { FilesChangedRow } from './files-changed/FilesChangedRow'

function ActivityNarrative({
  item,
  preview
}: {
  item: Extract<ActivityItem, { kind: 'text' | 'thinking' }>
  preview?: boolean
}) {
  const live = useLiveBlock(item.stream === 'open' ? streamKeyOf(item) : undefined)
  const [expanded, setExpanded] = useRowUiState('activity-preview', false, false)
  const id = useId()
  const text = live?.text || item.text
  const thinking = item.kind === 'thinking'
  if (!text && item.stream !== 'open') return null
  const Icon = thinking ? Brain : MessageSquare
  if (preview) {
    return (
      <div className="my-1 max-w-[620px] rounded-md bg-card/40 text-xs">
        <button
          type="button"
          aria-label={thinking ? 'Thinking' : 'Message'}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted/40"
        >
          <Icon className="size-3 shrink-0 text-muted-foreground" />
          <span
            className={cn('min-w-0 flex-1 truncate', thinking && 'italic text-muted-foreground')}
          >
            {text || 'Thinking…'}
          </span>
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90'
            )}
          />
        </button>
        <div
          id={id}
          hidden={!expanded}
          className={cn(
            'px-3 pb-2 pl-8 leading-relaxed',
            thinking && 'whitespace-pre-wrap italic text-muted-foreground'
          )}
        >
          {expanded &&
            (thinking ? (
              <HighlightedText text={text || 'Thinking…'} />
            ) : (
              <GhMarkdown>{text}</GhMarkdown>
            ))}
        </div>
      </div>
    )
  }
  return (
    <div
      className="my-1 flex max-w-[620px] gap-2 rounded-md bg-card/40 px-3 py-2 text-xs"
      aria-label={thinking ? 'Thinking' : 'Message'}
    >
      <Icon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
      {thinking ? (
        <div className="whitespace-pre-wrap italic text-muted-foreground">
          <HighlightedText text={text || 'Thinking…'} />
        </div>
      ) : (
        <div className="min-w-0 leading-relaxed [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
          <GhMarkdown>{text}</GhMarkdown>
        </div>
      )}
    </div>
  )
}

function ActivityEntry({
  item,
  row,
  preview
}: {
  item: ActivityItem
  row?: number
  preview?: boolean
}) {
  const key =
    streamKeyOf(item) ??
    (item.kind === 'tool'
      ? `tool:${item.invocation.id}`
      : `${item.kind}:${item.messageId}:${item.blockOrdinal ?? 0}`)
  return (
    <TimelineRowKeyContext.Provider value={key}>
      <TimelineRowIndexContext.Provider value={row}>
        {item.kind === 'tool' ? (
          <ToolInActivityContext.Provider value>
            {renderTimelineItem(item, key)}
          </ToolInActivityContext.Provider>
        ) : (
          <ActivityNarrative item={item} preview={preview} />
        )}
      </TimelineRowIndexContext.Provider>
    </TimelineRowKeyContext.Provider>
  )
}

export function AgentAvatar() {
  return (
    <div
      data-testid="chat-agent-avatar"
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-agent to-agent-emphasis text-agent-contrast shadow-sm"
    >
      <Sparkles className="size-3.5" />
    </div>
  )
}

export function ActivityTurn({
  turn,
  appearance,
  rowOf
}: {
  turn: ActivityTurnData
  appearance: Pick<
    AppearanceSettings,
    | 'chatShowActivities'
    | 'chatPreviewLatestActivity'
    | 'chatShowActivityMessages'
    | 'chatShowThinking'
    | 'chatShowActivityTools'
  >
  rowOf?: (item: ActivityItem) => number | undefined
}) {
  const [expanded, setExpanded] = useRowUiState('activity', false, false)
  const [forced, setForced] = useState(false)
  const focus = useContext(ToolFocusContext)
  const id = useId()
  // A file summary can request a tool hidden inside this disclosure.
  useEffect(() => {
    if (!focus) return
    const tools = turn.items
      .filter((item) => item.kind === 'tool')
      .map((item) => item.invocation.id)
    const check = (): void => {
      if (tools.some((tool) => focus.isPending(tool))) {
        setForced(true)
        setExpanded(true)
      }
    }
    const cleanups = tools.map((tool) => focus.subscribe(tool, check))
    check()
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [focus, turn.items, setExpanded])
  const filtered = turn.items.filter((item) =>
    item.kind === 'text'
      ? appearance.chatShowActivityMessages
      : item.kind === 'thinking'
        ? appearance.chatShowThinking
        : appearance.chatShowActivityTools
  )
  const items = forced ? turn.items : filtered
  const showSummary = appearance.chatShowActivities || forced
  const latest =
    turn.active && appearance.chatPreviewLatestActivity && !(showSummary && expanded)
      ? filtered[filtered.length - 1]
      : undefined
  if ((!showSummary || !turn.items.length) && !latest && !turn.files.length) return null
  return (
    <div className="flex flex-wrap items-start gap-x-2 pl-14 pr-4" data-testid="chat-activity">
      {showSummary && turn.items.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => {
              setExpanded(!expanded)
              if (expanded) setForced(false)
            }}
            className="flex w-fit max-w-full items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-3 py-1.5 text-left text-xs text-muted-foreground shadow-sm hover:bg-muted/50"
          >
            <Wrench className="size-3 shrink-0" />
            <span className="font-medium text-foreground">Activities</span>
            <span>
              {items.length} {items.length === 1 ? 'item' : 'items'}
            </span>
            <ChevronRight
              className={cn(
                'size-3 transition-transform motion-reduce:transition-none',
                expanded && 'rotate-90'
              )}
            />
          </button>
          <div id={id} hidden={!expanded} className="order-1 min-w-0 basis-full">
            {expanded &&
              items.map((item, index) => (
                <ActivityEntry
                  key={
                    streamKeyOf(item) ??
                    (item.kind === 'tool'
                      ? item.invocation.id
                      : `${item.messageId}:${item.blockOrdinal ?? index}`)
                  }
                  item={item}
                  row={rowOf?.(item)}
                />
              ))}
          </div>
        </>
      )}
      {turn.files.map((item) => (
        <FilesChangedRow key={item.id} item={item} embedded />
      ))}
      {latest && (
        <div className="order-2 min-w-0 basis-full">
          <ActivityEntry item={latest} row={rowOf?.(latest)} preview />
        </div>
      )}
    </div>
  )
}
