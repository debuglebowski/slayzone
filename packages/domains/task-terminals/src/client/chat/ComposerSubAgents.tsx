import { useId, useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { useNow } from '@slayzone/ui'
import type { BackgroundSubAgent } from '@slayzone/terminal/client'
import { SubAgentsPill } from './SubAgentsPill'
import { formatSeconds } from './tool-cards/command-live'

const NONE: ReadonlySet<string> = new Set()

/**
 * The composer's sub-agents: those still running after their turn closed
 * (`selectBackgroundSubAgents`). The turn's own Sub-agents pill, opening to one
 * row per sub-agent in its turn's look: its name shows its row in the chat,
 * Stop stops it alone.
 */
export function ComposerSubAgents({
  agents,
  onOpen,
  onStop,
  defaultExpanded = false
}: {
  agents: readonly BackgroundSubAgent[]
  /** Show its row in its turn. */
  onOpen?: (agent: BackgroundSubAgent) => void
  /**
   * Stop it (it reads as stopping until it ends; a rejection lets it be pressed
   * again). Absent: the agent cannot stop a single one.
   */
  onStop?: (agent: BackgroundSubAgent) => Promise<void> | void
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [stopping, setStopping] = useState<ReadonlySet<string>>(NONE)
  const stop = (agent: BackgroundSubAgent): void => {
    if (!onStop || stopping.has(agent.toolUseId)) return
    setStopping((prev) => new Set(prev).add(agent.toolUseId))
    Promise.resolve(onStop(agent)).catch(() =>
      setStopping((prev) => {
        const next = new Set(prev)
        next.delete(agent.toolUseId)
        return next
      })
    )
  }
  const id = useId()
  const now = useNow(1000, { enabled: agents.length > 0 && expanded })
  if (agents.length === 0) return null
  return (
    <div
      className={`mb-2 ${expanded ? 'w-full' : 'w-fit max-w-full'} min-w-0`}
      data-testid="composer-sub-agents"
    >
      <SubAgentsPill
        running
        count={`${agents.length} running`}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controls={id}
        testId="composer-sub-agents-toggle"
      />
      <div id={id} hidden={!expanded} className="mt-1 max-h-56 space-y-1 overflow-y-auto">
        {expanded &&
          agents.map((agent) => {
            const name = agent.description
            return (
              <div
                key={agent.toolUseId}
                className="flex min-w-0 items-center gap-2"
                data-testid="composer-sub-agent"
              >
                <div className="w-fit min-w-0 max-w-full overflow-hidden rounded-md border border-border/50 bg-muted/20">
                  <button
                    type="button"
                    onClick={() => onOpen?.(agent)}
                    disabled={!onOpen}
                    aria-label={name ? `Show sub-agent ${name}` : 'Show sub-agent'}
                    className="flex max-w-full items-center gap-2 px-3 py-1.5 text-left text-xs enabled:cursor-pointer enabled:hover:bg-muted/40"
                  >
                    <Loader2 className="size-3 shrink-0 animate-spin text-agent" />
                    <Bot className="size-3 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 font-medium">Sub-agent</span>
                    <span className="flex min-w-0 items-center gap-2 truncate font-mono text-[11px] text-muted-foreground">
                      {name && (
                        <>
                          <span className="text-muted-foreground/40">·</span>
                          <span className="truncate">{name}</span>
                        </>
                      )}
                      {agent.timestamp !== undefined && (
                        <>
                          <span className="text-muted-foreground/40">·</span>
                          <span className="shrink-0 tabular-nums">
                            {formatSeconds(now - agent.timestamp)}
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                </div>
                {onStop && (
                  <button
                    type="button"
                    onClick={() => stop(agent)}
                    disabled={stopping.has(agent.toolUseId)}
                    aria-label={name ? `Stop sub-agent ${name}` : 'Stop sub-agent'}
                    className="shrink-0 rounded-md border border-border/50 px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-muted/50 enabled:hover:text-foreground disabled:opacity-60"
                  >
                    {stopping.has(agent.toolUseId) ? 'Stopping…' : 'Stop'}
                  </button>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}
