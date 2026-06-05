import { type Dispatch, type Key, type SetStateAction } from 'react'
import { ArrowDown, Sparkles } from 'lucide-react'
import {
  cn,
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
  type AppearanceSettings
} from '@slayzone/ui'
import {
  BackgroundJobsBanner,
  PulseGrid,
  deriveLoadingLabel,
  isAwaitingUserQuestion,
  type TimelineItem,
  type ChatTimelineState
} from '@slayzone/terminal/client'
import { ChatSearchBar } from './ChatSearchBar'
import { renderTimelineItem } from './renderers'
import type { useChatSearch } from './useChatSearch'
import type { CallbackRef } from './useFollowBottom'

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
  appearance: AppearanceSettings
  hiddenCount: number
  PAGE_SIZE: number
  setVisibleCount: Dispatch<SetStateAction<number>>
  visibleItems: TimelineItem[]
  visibleStart: number
  itemKey: (item: TimelineItem, index: number) => Key
  scrollRef: CallbackRef<HTMLElement>
  contentRef: CallbackRef<HTMLElement>
  isAtBottom: boolean
  scrollToBottom: () => void
  sendMessage: (text: string) => Promise<void>
  copyLastResponse: () => void
  copyAllMessages: () => void
  copySessionId: () => void
  setCollapseSignal: Dispatch<SetStateAction<number>>
  handleReset: () => void | Promise<void>
  resetting: boolean
}

/**
 * Everything above the composer: the optional override-notice banner, the
 * Cmd+F search bar, the floating background-jobs banner, and the timeline scroll
 * region (paginated item list + typing indicator) wrapped in its right-click
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
  appearance,
  hiddenCount,
  PAGE_SIZE,
  setVisibleCount,
  visibleItems,
  visibleStart,
  itemKey,
  scrollRef,
  contentRef,
  isAtBottom,
  scrollToBottom,
  sendMessage,
  copyLastResponse,
  copyAllMessages,
  copySessionId,
  setCollapseSignal,
  handleReset,
  resetting
}: ChatTimelineProps) {
  const widthClass = appearance.chatWidth === 'wide' ? 'max-w-none' : 'max-w-4xl'
  return (
    <>
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
                {!hydrating && !(isEmpty && !inFlight) && (
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
                    {inFlight && !isAwaitingUserQuestion(state) && (
                      <TypingIndicator label={deriveLoadingLabel(state)} />
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
          <ContextMenuItem onSelect={search.requestOpen}>Find in chat… (⌘F)</ContextMenuItem>
          <ContextMenuItem onSelect={() => setCollapseSignal((n) => n + 1)}>
            Collapse all expanded blocks
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Width</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={appearance.chatWidth}
                onValueChange={(v) => {
                  window.api.settings.set('chat_width', v)
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              >
                <ContextMenuRadioItem value="narrow">Narrow</ContextMenuRadioItem>
                <ContextMenuRadioItem value="wide">Wide</ContextMenuRadioItem>
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
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

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center px-6 text-center">
      <div className="h-[30%] shrink-0" />
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
        <span
          className="size-1.5 rounded-full bg-foreground/40 animate-bounce"
          style={{ animationDelay: '0ms' }}
        />
        <span
          className="size-1.5 rounded-full bg-foreground/40 animate-bounce"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="size-1.5 rounded-full bg-foreground/40 animate-bounce"
          style={{ animationDelay: '300ms' }}
        />
      </div>
      {label && (
        <span className="text-xs text-muted-foreground truncate max-w-[60ch]">{label}</span>
      )}
    </div>
  )
}
