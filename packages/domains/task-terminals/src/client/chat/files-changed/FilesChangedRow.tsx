import { useContext, useState } from 'react'
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react'
import { cn, useDepsChanged } from '@slayzone/ui'
import type { TimelineItem, TimelineRows, TurnFileChange } from '@slayzone/terminal/client'
import { useChatView } from '../ChatViewContext'
import { CHAT_CARD_INDENT } from '../tool-cards/card-shell'
import { CardBadge } from '../tool-cards/links'
import { ToolFocusContext } from '../tool-cards/tool-focus'
import { flashRow, useRevealTimelineItem } from '../timeline-reveal'
import { stableAnchorKey } from '../useChatDisplay'
import { relativeToCwd } from './relative-path'
import { TurnFooterPanel } from '../turn-footer'

type FilesChangedItem = Extract<TimelineItem, { kind: 'files-changed' }>

/** `+a −d`, or nothing when a count is unknown (notebook cells). */
export function LineCounts({
  additions,
  deletions
}: {
  additions: number | null
  deletions: number | null
}) {
  if (additions === null || deletions === null) return null
  return (
    <span className="shrink-0 font-mono tabular-nums">
      <span className="text-diff-added-foreground">+{additions}</span>{' '}
      <span className="text-diff-removed-foreground">−{deletions}</span>
    </span>
  )
}

/** The total, or null when one of the counts is unknown. */
function sum(values: Array<number | null>): number | null {
  let total = 0
  for (const v of values) {
    if (v === null) return null
    total += v
  }
  return total
}

/**
 * The sub-agent rows a sub-agent's call sits in, outermost first (its card is
 * inside the outermost one, a row of the timeline). Null when one is missing.
 */
function subAgentsAround(
  timeline: Readonly<TimelineRows>,
  parentToolUseId: string | undefined
): Array<Extract<TimelineItem, { kind: 'sub-agent' }>> | null {
  const chain: Array<Extract<TimelineItem, { kind: 'sub-agent' }>> = []
  for (let parent = parentToolUseId; parent != null; ) {
    const agent = timeline.find(
      (it): it is Extract<TimelineItem, { kind: 'sub-agent' }> =>
        it?.kind === 'sub-agent' && it.toolUseId === parent
    )
    if (!agent || chain.includes(agent)) return null
    chain.unshift(agent)
    parent = agent.parentToolUseId
  }
  return chain
}

export function useShowFileChange(captureId?: string) {
  const { timeline, finalOnly, filesPanel } = useChatView()
  const reveal = useRevealTimelineItem()
  const focus = useContext(ToolFocusContext)
  return (file: TurnFileChange): void => {
    const id = file.toolUseIds[0]
    const tool = timeline.find((it) => it?.kind === 'tool' && it.invocation.id === id)
    const around = tool && !finalOnly ? subAgentsAround(timeline, tool.parentToolUseId) : null
    // The timeline row the card is in: its own, or its outermost sub-agent's.
    const host = around ? (around[0] ?? tool) : undefined
    const key = host ? stableAnchorKey(host) : null
    if (!around || !key) {
      if (captureId) filesPanel?.open(file.path, captureId)
      else filesPanel?.open(file.path)
      return
    }
    for (const agent of around) focus?.request(agent.toolUseId)
    focus?.request(id)
    reveal(key, { align: 'center' })
    flashRow(key)
  }
}

/**
 * The turn summary opens the changes panel; its disclosure shows the inline list.
 * A file shows the card that made its first change in the turn (scrolled to and
 * opened) — for a sub-agent's change, inside its sub-agent row (revealed and
 * opened down to the card). One whose card is hidden (final replies only), or
 * whose sub-agent row is unknown, opens the files-changed panel at that file.
 */
export function FilesChangedRow({
  item,
  embedded = false,
  captureId
}: {
  item: FilesChangedItem
  embedded?: boolean
  captureId?: string
}) {
  const { cwd, filesPanel, collapseSignal } = useChatView()
  const [open, setOpen] = useState(false)
  if (useDepsChanged([collapseSignal])) setOpen(false)
  const additions = sum(item.files.map((f) => f.additions))
  const deletions = sum(item.files.map((f) => f.deletions))
  const count = item.files.length

  const show = useShowFileChange(captureId)

  return (
    <div
      className={cn(embedded ? 'contents' : `${CHAT_CARD_INDENT} pr-4 py-1`)}
      data-testid="chat-files-changed"
    >
      <div
        className={
          embedded
            ? 'contents'
            : 'w-fit max-w-full rounded-lg border border-border/50 bg-card/40 text-xs overflow-hidden shadow-sm'
        }
      >
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-1.5',
            embedded && 'max-w-full rounded-lg border border-border/50 bg-card/40 text-xs shadow-sm'
          )}
        >
          <button
            type="button"
            data-testid="chat-files-changed-open"
            title="Open changes panel"
            onClick={() =>
              filesPanel
                ? captureId
                  ? filesPanel.open(undefined, captureId)
                  : filesPanel.open()
                : setOpen(!open)
            }
            className="flex min-w-0 items-center gap-2 text-left hover:text-foreground"
          >
            <FileDiff className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-medium">
              {count} file{count === 1 ? '' : 's'} changed
            </span>
            <LineCounts additions={additions} deletions={deletions} />
            <span className="text-muted-foreground">Recorded edits only</span>
          </button>
          <button
            type="button"
            data-testid="chat-files-changed-toggle"
            aria-label="Toggle changed file list"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="shrink-0 rounded text-muted-foreground hover:text-foreground"
          >
            {open ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            )}
          </button>
        </div>
        {open && (
          <TurnFooterPanel>
            <ul
              className={cn(
                'border-t border-border/40 bg-background/40 py-1',
                embedded && 'order-3 min-w-0 basis-full rounded-lg border text-xs'
              )}
            >
              {item.files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    data-testid="chat-files-changed-file"
                    data-path={file.path}
                    onClick={() => show(file)}
                    title={file.path}
                    className="flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left hover:bg-muted/40"
                  >
                    <span className="truncate font-mono text-[11px] [direction:rtl]">
                      <bdi>{relativeToCwd(file.path, cwd)}</bdi>
                    </span>
                    {file.created && <CardBadge>New</CardBadge>}
                    <LineCounts additions={file.additions} deletions={file.deletions} />
                    {file.toolUseIds.length > 1 && (
                      <span className="shrink-0 text-muted-foreground">
                        {file.toolUseIds.length} edits
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {item.shellCommands > 0 && (
                <li
                  data-testid="chat-files-changed-shell-note"
                  className="px-3 py-1 text-[11px] text-muted-foreground"
                >
                  {item.shellCommands} shell command{item.shellCommands === 1 ? '' : 's'} ran in
                  this turn too: files they changed are not listed.
                </li>
              )}
            </ul>
          </TurnFooterPanel>
        )}
      </div>
    </div>
  )
}
