import { AlertTriangle } from 'lucide-react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatView } from './ChatViewContext'

const PRODUCT: Record<string, { name: string; install: string }> = {
  claude: { name: 'Claude Code', install: 'https://claude.com/claude-code' },
  codex: { name: 'Codex', install: 'https://github.com/openai/codex' }
}

/** The agent could not be started — what happened, and the way out. */
export function AgentProblemCard({
  item
}: {
  item: Extract<TimelineItem, { kind: 'agent-problem' }>
}): React.JSX.Element {
  const { restartAgent, onOpenUrl } = useChatView()
  const product = item.binary ? PRODUCT[item.binary] : undefined
  const name = product?.name ?? item.binary ?? 'The agent'
  const title =
    item.code === 'cli-not-installed'
      ? `${name} isn't installed`
      : item.code === 'spawn-refused'
        ? 'The computer refused to start the agent'
        : "The agent couldn't start"
  const hint =
    item.code === 'cli-not-installed'
      ? `Install ${name} on the computer this task runs on (it must be on that computer's PATH), then retry.`
      : 'Fix the cause below, then retry.'
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
      <p className="mt-1 font-mono text-[11px] text-muted-foreground break-words">{item.message}</p>
      <div className="mt-2 flex gap-2">
        {restartAgent ? (
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent"
            onClick={() => restartAgent()}
          >
            Retry
          </button>
        ) : null}
        {item.code === 'cli-not-installed' && product && onOpenUrl ? (
          <button
            type="button"
            className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onOpenUrl(product.install)}
          >
            How to install
          </button>
        ) : null}
      </div>
    </div>
  )
}
