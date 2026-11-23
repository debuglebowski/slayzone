import { agentProblemText } from '@slayzone/terminal/chat-presentation'
import { AlertTriangle } from 'lucide-react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { chatProviderForBinary } from '@slayzone/terminal-contracts'
import { useChatView } from './ChatViewContext'

/** The agent could not be started — what happened, and the way out. */
export function AgentProblemCard({
  item
}: {
  item: Extract<TimelineItem, { kind: 'agent-problem' }>
}): React.JSX.Element {
  const { restartAgent, restartingAgent, takeOver, onOpenUrl } = useChatView()
  const { title, hint, inUse } = agentProblemText(item)
  const product = item.binary ? chatProviderForBinary(item.binary) : null
  if (item.resolved) {
    // History: the agent started after it. No Retry — it would replace that agent.
    return (
      <div
        data-agent-problem={item.code}
        data-resolved
        className="mx-4 my-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
      >
        <div className="flex items-center gap-1.5 font-medium">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>{title}</span>
        </div>
        <p className="mt-1 font-mono text-2xs break-words">{item.message}</p>
        <p className="mt-1">The agent started after this.</p>
      </div>
    )
  }
  return (
    <div
      data-agent-problem={item.code}
      role="alert"
      className="mx-4 my-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5 font-medium text-destructive">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span>{title}</span>
      </div>
      <p className="mt-1 text-foreground">{hint}</p>
      <p className="mt-1 font-mono text-2xs text-muted-foreground break-words">{item.message}</p>
      <div className="mt-2 flex gap-2">
        {inUse && takeOver ? (
          <button
            type="button"
            data-testid="chat-take-over"
            className="rounded border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent"
            onClick={() => takeOver()}
          >
            Continue here
          </button>
        ) : null}
        {restartAgent ? (
          <button
            type="button"
            disabled={restartingAgent}
            className="rounded border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
            onClick={() => restartAgent()}
          >
            {restartingAgent ? 'Retrying…' : 'Retry'}
          </button>
        ) : null}
        {item.code === 'cli-not-installed' && product && onOpenUrl ? (
          <button
            type="button"
            className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onOpenUrl(product.installUrl)}
          >
            How to install
          </button>
        ) : null}
      </div>
    </div>
  )
}
