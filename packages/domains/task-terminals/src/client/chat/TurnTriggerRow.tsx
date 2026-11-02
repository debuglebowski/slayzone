import { useContext } from 'react'
import { Bot, CornerDownRight } from 'lucide-react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { CHAT_CARD_INDENT } from './tool-cards/card-shell'
import { ToolFocusContext } from './tool-cards/tool-focus'
import { flashRow, useRevealTimelineItem } from './timeline-reveal'

type TurnTriggerItem = Extract<TimelineItem, { kind: 'turn-trigger' }>

/**
 * The agent opened this turn because background sub-agents ended: which ones.
 * A name shows its sub-agent row (scrolled to, its Activities opened).
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
      className={`${CHAT_CARD_INDENT} flex min-w-0 flex-wrap items-center gap-1.5 py-1 text-xs text-muted-foreground`}
      data-testid="turn-trigger"
    >
      <CornerDownRight className="size-3 shrink-0" />
      <span>After</span>
      {item.subAgents.map((agent, i) => (
        <span key={agent.toolUseId} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span className="text-muted-foreground/40">·</span>}
          <button
            type="button"
            onClick={() => show(agent.toolUseId)}
            className="flex min-w-0 items-center gap-1 rounded-sm px-1 hover:bg-muted/50 hover:text-foreground"
          >
            <Bot className="size-3 shrink-0" />
            <span className="truncate">{agent.description ?? 'sub-agent'}</span>
          </button>
        </span>
      ))}
      <span>finished</span>
    </div>
  )
}
