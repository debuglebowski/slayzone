import { useState, useSyncExternalStore } from 'react'
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  ListOrdered,
  Loader2,
  Square,
  X
} from 'lucide-react'
import { cn, detectPlatform } from '@slayzone/ui'
import { useRevealTimelineItem } from './timeline-reveal'
import { formatTime } from './tool-cards/card-shell'
import type { TurnEntry, TurnStatus } from './turn-outline'
import type { VirtualTimelineController } from './virtual-timeline'

/** The keys that move between turns, as the platform writes them. */
const TURN_KEYS = detectPlatform() === 'mac' ? '⌘⌥↑ / ⌘⌥↓' : 'Alt+PgUp / Alt+PgDn'

const STATUS_LABEL: Record<TurnStatus, string> = {
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  stopped: 'Stopped',
  sending: 'Sending',
  failed: 'Not sent'
}

function StatusIcon({ status }: { status: TurnStatus }) {
  const cls = 'size-3 shrink-0'
  switch (status) {
    case 'running':
      return <Loader2 className={cn(cls, 'animate-spin text-agent')} />
    case 'done':
      return <CircleCheck className={cn(cls, 'text-success')} />
    case 'error':
      return <CircleX className={cn(cls, 'text-destructive')} />
    case 'stopped':
      return <Square className={cn(cls, 'text-muted-foreground')} />
    case 'sending':
      return <Clock className={cn(cls, 'text-muted-foreground')} />
    case 'failed':
      return <CircleAlert className={cn(cls, 'text-destructive')} />
  }
}

/**
 * The turn the view is in: the last one starting at or above the row at the
 * top. `version` stands for the scroll position (it changes when it does).
 */
function currentTurn(
  turns: readonly TurnEntry[],
  virtual: VirtualTimelineController,
  _version: number
): number {
  const top = virtual.topIndex()
  let at = -1
  for (let i = 0; i < turns.length && turns[i].index <= top; i++) at = i
  return at
}

/**
 * Jump between turns (plan 4.3): a compact outline, one entry per user turn —
 * the message's first line, its time, how it went — that scrolls the timeline
 * to that turn (the reveal seam: the row need not be mounted). Docked top-left
 * inside the timeline, over it (no reflow), so the right side stays free for
 * the files-changed panel. The entry of the turn in view is marked.
 */
export function ChatTurnOutline({
  turns,
  virtual
}: {
  turns: readonly TurnEntry[]
  virtual: VirtualTimelineController
}) {
  const [open, setOpen] = useState(false)
  const reveal = useRevealTimelineItem()
  const version = useSyncExternalStore(virtual.subscribe, virtual.getVersion, virtual.getVersion)
  const current = open ? currentTurn(turns, virtual, version) : -1
  if (turns.length === 0) return null
  return (
    <div className="pointer-events-none absolute top-2 left-3 z-20 flex flex-col items-start gap-1">
      <button
        type="button"
        data-testid="chat-turn-outline-toggle"
        aria-expanded={open}
        title={`Turns (${TURN_KEYS} to move between them)`}
        onClick={() => setOpen(!open)}
        className={cn(
          'pointer-events-auto inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground',
          open && 'text-foreground'
        )}
      >
        <ListOrdered className="size-3.5" />
        <span className="tabular-nums">{turns.length}</span>
      </button>
      {open && (
        <nav
          data-testid="chat-turn-outline"
          aria-label="Turns"
          className="pointer-events-auto w-72 max-w-[calc(100vw-2rem)] max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-border/60 bg-popover px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>
              {turns.length} turn{turns.length === 1 ? '' : 's'} · {TURN_KEYS}
            </span>
            <button
              type="button"
              aria-label="Close turns"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
          <ol className="py-1">
            {turns.map((turn, i) => (
              <li key={String(turn.key)}>
                <button
                  type="button"
                  data-testid="chat-turn-outline-item"
                  data-current={i === current ? 'true' : undefined}
                  title={`${STATUS_LABEL[turn.status]} · ${turn.title}`}
                  onClick={() => reveal(turn.key, { align: 'start' })}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground',
                    i === current && 'bg-muted'
                  )}
                >
                  <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <StatusIcon status={turn.status} />
                  <span className="min-w-0 flex-1 truncate">{turn.title}</span>
                  <time className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                    {formatTime(turn.timestamp)}
                  </time>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </div>
  )
}
