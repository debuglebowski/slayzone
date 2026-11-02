import {
  useContext,
  useMemo,
  useCallback,
  useId,
  useEffect,
  useRef,
  type Dispatch,
  type Key,
  type SetStateAction
} from 'react'
import { ArrowDown, ChevronRight, Sparkles, Wrench } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '../trpc'
import {
  cn,
  LoadingDots,
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
  type AppearanceSettings,
  formatKeysForDisplay,
  withShortcut
} from '@slayzone/ui'
import {
  PulseGrid,
  deriveLoadingLabel,
  type TimelineItem,
  type ChatTimelineState
} from '@slayzone/terminal/client'
import { toolActivityByRow, type TurnToolActivity } from './tool-activity'
import { ActivityTurn } from './ActivityTurn'
import { AssistantAnswer } from './AssistantAnswer'
import { CHAT_SCROLLER_BLEED_CLASS, chatColumnClass } from './chat-layout'
import type { ActivityTurn as ActivityTurnData } from './activity-view'
import { FilesChangedRow } from './files-changed/FilesChangedRow'
import { ToolAutoOpenContext } from './tool-cards/card-shell'
import { ChatSearchBar } from './ChatSearchBar'
import { renderTimelineItem } from './renderers'
import { useChatProvider } from './ChatViewContext'
import type { TerminalMode } from '@slayzone/terminal-contracts'
import { MODE_ICONS } from '../mode-icons'
import {
  TimelineRowKeyContext,
  TimelineRowIndexContext,
  RowUiStateContext,
  useRowUiState,
  collapseAllRows
} from './row-ui-state'
import type { useChatSearch } from './useChatSearch'
import type { CallbackRef } from './useFollowBottom'
import { VirtualTimelineRows } from './VirtualTimelineRows'
import type { VirtualTimelineController } from './virtual-timeline'

const SUGGESTED_PROMPTS = [
  'Explain what this codebase does',
  'Find the entry point',
  'What are the main dependencies?'
]

export interface ChatTimelineProps {
  overrideNotice?: string | null
  search: ReturnType<typeof useChatSearch>
  state: ChatTimelineState
  hydrating: boolean
  isEmpty: boolean
  inFlight: boolean
  /** The agent is waiting on the user (a prompt) — no "working" indicator then. */
  awaitingUser: boolean
  appearance: AppearanceSettings
  /** Every displayed row; only those in view are mounted (`virtual`). */
  hiddenTools?: ChatTimelineState['timeline']
  activityTurns?: ReadonlyMap<TimelineItem, ActivityTurnData>
  folded?: ReadonlySet<number>
  items: TimelineItem[]
  virtual: VirtualTimelineController
  /** `virtual.bindScroller`, as its own prop: what goes to `ref` must not be read off `virtual`. */
  scrollRef: CallbackRef<HTMLElement>
  itemKey: (item: TimelineItem, index: number) => Key
  /** A displayed row's index in the timeline (scroll anchors keep it). */
  rowOf?: (item: TimelineItem) => number | undefined
  contentRef: CallbackRef<HTMLElement>
  isAtBottom: boolean
  scrollToBottom: () => void
  sendMessage: (text: string) => Promise<void>
  copyLastResponse: () => void
  copyAllMessages: () => void
  copySessionId: () => void
  setCollapseSignal: Dispatch<SetStateAction<number>>
  handleReset: () => void | Promise<void>
  /** "Continue in terminal" (main tab, a conversation exists). */
  onHandoff?: () => void
  resetting: boolean
}

/**
 * Everything above the composer: the optional override-notice banner, the
 * Cmd+F search bar, and the timeline scroll
 * region (virtualized item list + typing indicator) wrapped in its right-click
 * context menu, plus the Hydrating / Empty overlays and jump-to-latest button.
 *
 * Purely presentational — all state + handlers are threaded in from ChatPanel.
 */
export function ChatTimeline({
  overrideNotice,
  search,
  state,
  hydrating,
  isEmpty,
  inFlight,
  awaitingUser,
  appearance,
  items,
  hiddenTools,
  activityTurns,
  folded,
  rowOf,
  virtual,
  scrollRef,
  itemKey,
  contentRef,
  isAtBottom,
  scrollToBottom,
  sendMessage,
  copyLastResponse,
  copyAllMessages,
  copySessionId,
  setCollapseSignal,
  handleReset,
  resetting,
  onHandoff
}: ChatTimelineProps) {
  let loadedRows = 0
  for (const row of state.timeline) if (row !== undefined) loadedRows++
  const trpc = useTRPC()
  const settingsSetMutation = useMutation(trpc.settings.set.mutationOptions())
  const rowUiState = useContext(RowUiStateContext)
  // A row that streams already says what the agent does ("Thinking… 3s", the
  // reply growing): no second indicator under it.
  const tail = items[items.length - 1]
  const tailStreaming =
    (tail?.kind === 'text' || (tail?.kind === 'thinking' && appearance.chatShowThinking)) &&
    tail.stream === 'open'
  const loadingLabel = deriveLoadingLabel(state) ?? 'Waiting for agent…'
  const activityAppearance = useMemo(
    () => ({
      chatShowActivities: appearance.chatShowActivities,
      chatPreviewLatestActivity: appearance.chatPreviewLatestActivity,
      chatShowActivityMessages: appearance.chatShowActivityMessages,
      chatShowThinking: appearance.chatShowThinking,
      chatShowActivityTools: appearance.chatShowActivityTools
    }),
    [
      appearance.chatShowActivities,
      appearance.chatPreviewLatestActivity,
      appearance.chatShowActivityMessages,
      appearance.chatShowThinking,
      appearance.chatShowActivityTools
    ]
  )
  const showToolSummary = appearance.chatShowToolCallSummary !== false
  const showLatestTool = appearance.chatShowLatestToolCall !== false
  const activities = useMemo(
    () =>
      hiddenTools
        ? toolActivityByRow(hiddenTools, items, folded)
        : new Map<TimelineItem, TurnToolActivity>(),
    [hiddenTools, items, folded]
  )
  const renderRow = useCallback(
    (item: TimelineItem, index: number) => {
      const turn = activityTurns?.get(item)
      if (turn) {
        const showWorking = turn.active && !awaitingUser
        if ((turn.final && item.kind === 'text') || item.kind === 'interrupted') {
          return (
            <AssistantAnswer
              item={item}
              turn={turn}
              appearance={activityAppearance}
              rowOf={rowOf}
            />
          )
        }
        return (
          <>
            {!turn.hostIsActivity && renderTimelineItem(item, index)}
            <div className="relative">
              {showWorking && <TypingIndicator label={loadingLabel} />}
              <ActivityTurn turn={turn} appearance={activityAppearance} rowOf={rowOf} />
            </div>
          </>
        )
      }
      const activity = activities.get(item)
      if (!activity) return renderTimelineItem(item, index)
      const pending = activity.tools.filter(({ item }) => item.invocation.status === 'pending')
      const latest = pending[pending.length - 1]?.item.invocation.name
      const running = pending.length
      const files = item.kind === 'files-changed'
      return (
        <>
          {!files && renderTimelineItem(item, index)}
          <div className="mx-0 my-1 flex min-w-0 flex-wrap items-start gap-x-2">
            <ToolActivityDisclosure
              key={activity.key}
              tools={activity.tools}
              inFlight={inFlight && activity.latestTurn}
              latest={latest}
              running={running}
              showSummary={showToolSummary}
              showLatest={showLatestTool}
            />
            {files && <FilesChangedRow item={item} embedded />}
          </div>
        </>
      )
    },
    [
      activityTurns,
      awaitingUser,
      loadingLabel,
      rowOf,
      activityAppearance,
      activities,
      inFlight,
      showToolSummary,
      showLatestTool
    ]
  )
  const hasActiveTurn = activityTurns && [...activityTurns.values()].some((turn) => turn.active)
  return (
    <>
      {/* Header: mode pill + (override notice if explicitly passed by parent) */}
      {overrideNotice && (
        <div className="px-4 py-2 text-xs bg-warning/10 border-b border-warning/30 text-warning-foreground">
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

      {/* Timeline */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative flex-1 min-h-0">
            <div
              ref={scrollRef}
              // The virtualizer keeps the view in place as rows above it get
              // measured; the browser's own scroll anchoring would fight it.
              className={cn(
                CHAT_SCROLLER_BLEED_CLASS,
                'h-full overflow-y-auto [container-type:size] [overflow-anchor:none]'
              )}
              data-testid="chat-timeline-scroller"
              data-chat-scroller
              // What the renderer holds (paged history): diagnostics, e2e.
              data-rows-total={state.timeline.length}
              data-rows-loaded={loadedRows}
            >
              <div ref={contentRef} className="min-h-full">
                {!hydrating && !(isEmpty && !inFlight) && (
                  <div
                    data-chat-scroll-content
                    className={cn(
                      'pb-[40cqh]',
                      chatColumnClass(appearance.chatWidth),
                      appearance.chatWrapCode &&
                        '[&_pre]:whitespace-pre-wrap [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-words'
                    )}
                  >
                    <VirtualTimelineRows
                      controller={virtual}
                      items={items}
                      itemKey={itemKey}
                      rowOf={rowOf}
                      renderRow={renderRow}
                    />
                    {inFlight && !awaitingUser && !tailStreaming && !hasActiveTurn && (
                      <div className="relative">
                        <TypingIndicator label={loadingLabel} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Overlays — sibling of the scroll viewport so they own their own layout */}
            {hydrating && <HydratingState />}
            {!hydrating && isEmpty && !inFlight && (
              <EmptyState
                onPick={(text) => {
                  void sendMessage(text)
                }}
              />
            )}

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
            <ContextMenuItem onSelect={copySessionId}>Copy session id</ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={search.requestOpen}>
            {withShortcut('Find in chat…', formatKeysForDisplay('mod+f'))}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              // Rows scrolled out of view are closed too, when they come back.
              collapseAllRows(rowUiState, items, itemKey, state.timeline.length)
              setCollapseSignal((n) => n + 1)
            }}
          >
            Collapse all expanded blocks
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Width</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={appearance.chatWidth}
                onValueChange={(v) => {
                  settingsSetMutation.mutate(
                    { key: 'chat_width', value: v },
                    {
                      onSuccess: () => window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                    }
                  )
                }}
              >
                <ContextMenuRadioItem value="narrow">Default</ContextMenuRadioItem>
                <ContextMenuRadioItem value="wide">Full width</ContextMenuRadioItem>
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          {onHandoff && (
            <ContextMenuItem data-testid="chat-continue-in-terminal" onSelect={onHandoff}>
              Continue in terminal
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onSelect={() => {
              void handleReset()
            }}
            disabled={resetting}
          >
            Reset chat
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </>
  )
}

function HydratingState() {
  return (
    <div className="absolute inset-0">
      <PulseGrid />
    </div>
  )
}

export function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const provider = useChatProvider()
  const ProviderIcon = MODE_ICONS[provider.type as TerminalMode]
  return (
    <div className="absolute inset-0 flex flex-col items-center px-6 text-center">
      <div className="h-[30%] shrink-0" />
      {ProviderIcon ? (
        <div data-testid="chat-empty-provider-logo" data-provider={provider.type} className="mb-4">
          <ProviderIcon className="size-12" />
        </div>
      ) : (
        <div className="size-12 rounded-full bg-gradient-to-br from-agent to-agent-emphasis flex items-center justify-center text-agent-contrast shadow-lg mb-4">
          <Sparkles className="size-5" />
        </div>
      )}
      <div className="text-base font-medium">Chat with {provider.product}</div>
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
    <div data-testid="chat-working-indicator" className="px-0 py-2 flex gap-3 items-center">
      <LoadingDots />
      {label && (
        <span className="text-xs text-muted-foreground truncate max-w-[60ch]">{label}</span>
      )}
    </div>
  )
}

function ToolActivityDisclosure({
  tools,
  inFlight,
  latest,
  running,
  showSummary,
  showLatest
}: {
  tools: Array<{ item: Extract<TimelineItem, { kind: 'tool' }>; row: number }>
  inFlight: boolean
  latest: string | undefined
  running: number
  showSummary: boolean
  showLatest: boolean
}) {
  const [expanded, setExpanded] = useRowUiState('tool-activity', false, false)
  const id = useId()
  const latestTool =
    inFlight && showLatest
      ? tools.findLast(({ item }) => item.invocation.status === 'pending')
      : undefined
  const history = latestTool ? tools.filter((tool) => tool !== latestTool) : tools
  return (
    <div className="contents text-xs text-muted-foreground" data-testid="chat-tool-activity">
      {showSummary && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
          className="my-1 flex w-fit max-w-full items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-3 py-1.5 text-left shadow-sm hover:bg-muted/50"
        >
          <Wrench className="size-3 shrink-0" />
          <span className="shrink-0 font-medium text-foreground">
            {tools.length} {tools.length === 1 ? 'tool call' : 'tool calls'}
          </span>
          {inFlight && running > 0 && (
            <span className="min-w-0 truncate">
              {running} running: {latest}
            </span>
          )}
          <ChevronRight
            className={cn(
              'size-3 transition-transform duration-300 motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
          />
        </button>
      )}
      {showSummary && (
        <div
          id={id}
          inert={!expanded}
          className={cn(
            'order-1 basis-full min-w-0 grid transition-[grid-template-rows,opacity] duration-300 ease-in-out motion-reduce:transition-none',
            expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {history.map(({ item, row }) => (
              <ActivityTool key={item.invocation.id} item={item} row={row} autoOpen={false} />
            ))}
          </div>
        </div>
      )}
      {latestTool && (
        <div className="order-2 min-w-0 basis-full">
          <ActivityTool key={latestTool.item.invocation.id} {...latestTool} autoOpen />
        </div>
      )}
    </div>
  )
}

function ActivityTool({
  item,
  row,
  autoOpen
}: {
  item: Extract<TimelineItem, { kind: 'tool' }>
  row: number
  autoOpen: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!autoOpen || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animation = ref.current?.animate(
      [
        { opacity: 0, transform: 'translateY(6px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ],
      { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    )
    return () => animation?.cancel()
  }, [autoOpen])
  return (
    <div ref={ref}>
      <ToolAutoOpenContext.Provider value={autoOpen}>
        <TimelineRowKeyContext.Provider value={`tool:${item.invocation.id}`}>
          <TimelineRowIndexContext.Provider value={row}>
            {renderTimelineItem(item, item.invocation.id)}
          </TimelineRowIndexContext.Provider>
        </TimelineRowKeyContext.Provider>
      </ToolAutoOpenContext.Provider>
    </div>
  )
}
