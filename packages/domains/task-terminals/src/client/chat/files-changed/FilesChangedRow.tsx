import { useContext, useState } from 'react'
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react'
import { cn, useDepsChanged } from '@slayzone/ui'
import type { TimelineItem, TimelineRows, TurnFileChange } from '@slayzone/terminal/client'
import { useChatView } from '../ChatViewContext'
import { CHAT_CARD_INDENT } from '../tool-cards/card-shell'
import { CardBadge } from '../tool-cards/links'
import { ToolFocusContext } from '../tool-cards/tool-focus'
import { useRevealTimelineItem } from '../timeline-reveal'
import { stableAnchorKey } from '../useChatDisplay'
import { relativeToCwd } from './relative-path'

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

/** Highlights a timeline row briefly once it is on screen (it may mount after the reveal). */
function flashRow(key: string): void {
  const selector = `[data-item-key="${key.replace(/["\\]/g, '\\$&')}"]`
  let frames = 0
  const tick = (): void => {
    const row = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (el) => el.offsetParent !== null
    )
    if (row) {
      row.animate?.(
        [
          { backgroundColor: 'color-mix(in oklab, var(--color-ring) 22%, transparent)' },
          { backgroundColor: 'transparent' }
        ],
        { duration: 1400, easing: 'ease-out' }
      )
      return
    }
    if (++frames < 60) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
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

/**
 * The end of a turn that changed files: "N files changed", opening to the list.
 * A file shows the card that made its first change in the turn (scrolled to and
 * opened) — for a sub-agent's change, inside its sub-agent row (revealed and
 * opened down to the card). One whose card is hidden (final replies only), or
 * whose sub-agent row is unknown, opens the files-changed panel at that file.
 */
export function FilesChangedRow({ item }: { item: FilesChangedItem }) {
  const { cwd, timeline, finalOnly, filesPanel, collapseSignal } = useChatView()
  const reveal = useRevealTimelineItem()
  const focus = useContext(ToolFocusContext)
  const [open, setOpen] = useState(false)
  if (useDepsChanged([collapseSignal])) setOpen(false)
  const additions = sum(item.files.map((f) => f.additions))
  const deletions = sum(item.files.map((f) => f.deletions))
  const count = item.files.length

  const show = (file: TurnFileChange): void => {
    const id = file.toolUseIds[0]
    const tool = timeline.find((it) => it?.kind === 'tool' && it.invocation.id === id)
    const around = tool && !finalOnly ? subAgentsAround(timeline, tool.parentToolUseId) : null
    // The timeline row the card is in: its own, or its outermost sub-agent's.
    const host = around ? (around[0] ?? tool) : undefined
    const key = host ? stableAnchorKey(host) : null
    if (!around || !key) {
      filesPanel?.open(file.path)
      return
    }
    for (const agent of around) focus?.request(agent.toolUseId)
    focus?.request(id)
    reveal(key, { align: 'center' })
    flashRow(key)
  }

  return (
    <div className={cn(CHAT_CARD_INDENT, 'pr-4 py-1')} data-testid="chat-files-changed">
      <div className="w-fit max-w-full rounded-lg border border-border/50 bg-card/40 text-xs overflow-hidden shadow-sm">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <button
            type="button"
            data-testid="chat-files-changed-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 items-center gap-2 text-left hover:text-foreground"
          >
            <FileDiff className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-medium">
              {count} file{count === 1 ? '' : 's'} changed
            </span>
            <LineCounts additions={additions} deletions={deletions} />
            {open ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            )}
          </button>
          {filesPanel && (
            <button
              type="button"
              data-testid="chat-files-changed-view"
              onClick={() => filesPanel.open()}
              className="shrink-0 text-[11px] text-primary hover:underline"
            >
              View changes
            </button>
          )}
        </div>
        {open && (
          <ul className="border-t border-border/40 bg-background/40 py-1">
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
                {item.shellCommands} shell command{item.shellCommands === 1 ? '' : 's'} ran in this
                turn too: files they changed are not listed.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}
