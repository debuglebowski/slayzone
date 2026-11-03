import { Fragment, type ReactNode, useContext } from 'react'
import { Bot, Check, Timer, X } from 'lucide-react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import { CHAT_CARD_INDENT } from './tool-cards/card-shell'
import { ToolFocusContext } from './tool-cards/tool-focus'
import { flashRow, useRevealTimelineItem } from './timeline-reveal'
import {
  describeTurnTriggerNotification,
  type TurnTriggerNotification
} from './turn-trigger-notification'

type TurnTriggerItem = Extract<TimelineItem, { kind: 'turn-trigger' }>

/**
 * The agent opened this turn because background work told it something; each
 * message it received is shown above its answer. A sub-agent that ended: a
 * one-line card, its name and ✓ / ✕ (the name shows its sub-agent row —
 * scrolled to, its Activities opened). A line a watch printed: a labelled card
 * (`Watch` / `Printed`); a background task's end: `Task`. A watch that hit its
 * time limit: a short "Watch stopped" pill (which watch on hover).
 */
export function TurnTriggerRow({ item }: { item: TurnTriggerItem }) {
  const reveal = useRevealTimelineItem()
  const focus = useContext(ToolFocusContext)
  const show = (toolUseId: string): void => {
    const key = `sub-agent:${toolUseId}`
    focus?.request(toolUseId)
    reveal(key, { align: 'center' })
    flashRow(key)
  }
  return (
    <div
      className={`${CHAT_CARD_INDENT} space-y-1.5 py-1 text-xs text-muted-foreground`}
      data-testid="turn-trigger"
    >
      {item.subAgents.map((agent) => (
        <div
          key={agent.toolUseId}
          className="flex w-fit max-w-full items-center gap-2.5 rounded-lg border border-border/50 bg-card px-3 py-1.5"
          data-testid="turn-trigger-sub-agent"
        >
          <Bot className="size-3 shrink-0" />
          <button
            type="button"
            onClick={() => show(agent.toolUseId)}
            className="min-w-0 truncate text-left text-foreground hover:underline"
          >
            {agent.description ?? 'sub-agent'}
          </button>
          {agent.failed ? (
            <span role="img" aria-label="Failed" className="shrink-0 text-destructive">
              <X className="size-3.5" />
            </span>
          ) : (
            <span role="img" aria-label="Finished" className="shrink-0 text-success-foreground">
              <Check className="size-3.5" />
            </span>
          )}
        </div>
      ))}
      {item.notifications?.map((notification) => (
        <NotificationRow key={notification.uuid} notification={notification} />
      ))}
    </div>
  )
}

function NotificationRow({ notification }: { notification: TurnTriggerNotification }) {
  const view = describeTurnTriggerNotification(notification)
  if (view.kind === 'card') {
    return (
      <TriggerCard
        testId="turn-trigger-notification"
        rows={view.rows.map((row) => ({
          label: row.label,
          value: row.value,
          ...(row.mono ? { className: 'font-mono text-foreground/80' } : {})
        }))}
      />
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex w-fit max-w-full items-center gap-1.5 rounded-full border border-warning/35 bg-warning/10 px-2.5 py-0.5 text-warning-foreground"
          data-testid="turn-trigger-notification"
        >
          <Timer className="size-3 shrink-0" />
          <span className="truncate">{view.text}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        sideOffset={6}
        showArrow={false}
        className="max-w-sm space-y-0.5 rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-lg"
        data-testid="turn-trigger-notification-tooltip"
      >
        <p className="break-words font-medium">{view.tooltip.title}</p>
        <p className="text-muted-foreground">{view.tooltip.body}</p>
      </TooltipContent>
    </Tooltip>
  )
}

interface TriggerCardRow {
  label: string
  value: ReactNode
  /** Value styling (default: foreground prose). */
  className?: string
}

/** One message the agent received, labelled: `Watch <name>` / `Printed <line>`. */
function TriggerCard({ rows, testId }: { rows: readonly TriggerCardRow[]; testId: string }) {
  return (
    <div
      className="grid w-fit max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-0.5 rounded-lg border border-border/50 bg-card px-3 py-2"
      data-testid={testId}
    >
      {rows.map((row) => (
        <Fragment key={row.label}>
          <span>{row.label}</span>
          <span
            className={cn(
              'whitespace-pre-wrap [overflow-wrap:anywhere]',
              row.className ?? 'text-foreground'
            )}
          >
            {row.value}
          </span>
        </Fragment>
      ))}
    </div>
  )
}
