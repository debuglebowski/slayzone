import { Bot } from 'lucide-react'
import { CODEX_AGENT_TOOL_PREFIX } from '@slayzone/terminal-contracts'
import type { ToolInvocation } from '@slayzone/terminal/client'
import { ToolShell, resultTextOf, type ToolProps } from './card-shell'

/** What a Codex agent tool does, as the card's title (unknown tools: their name). */
const TITLES: Record<string, string> = {
  wait: 'Wait for sub-agents',
  sendInput: 'Message sub-agent',
  sendMessage: 'Message sub-agent',
  followupTask: 'Follow-up task',
  resumeAgent: 'Resume sub-agent',
  interruptAgent: 'Interrupt sub-agent',
  closeAgent: 'Close sub-agent',
  listAgents: 'List sub-agents'
}

export interface CodexAgentToolView {
  title: string
  /** The sub-agents it addresses (their names). */
  agents: string[]
  prompt?: string
}

export function codexAgentToolView(invocation: ToolInvocation): CodexAgentToolView {
  const tool = invocation.name.slice(CODEX_AGENT_TOOL_PREFIX.length)
  const input = (invocation.input ?? {}) as { agents?: unknown; prompt?: unknown }
  const agents = Array.isArray(input.agents)
    ? input.agents.filter((a): a is string => typeof a === 'string')
    : []
  return {
    title: TITLES[tool] ?? tool,
    agents,
    ...(typeof input.prompt === 'string' && input.prompt ? { prompt: input.prompt } : {})
  }
}

/** A Codex thread's agent tool (wait, message, close, …): whom, what, and how they are. */
export function CodexAgentToolCard({ invocation, timestamp }: ToolProps) {
  const view = codexAgentToolView(invocation)
  const result = resultTextOf(invocation)
  return (
    <ToolShell
      icon={<Bot className="size-3" />}
      title={view.title}
      invocation={invocation}
      timestamp={timestamp}
      summary={view.agents.join(', ')}
    >
      {(view.prompt || result) && (
        <div className="p-3 grid gap-2 text-xs">
          {view.prompt && <div className="whitespace-pre-wrap">{view.prompt}</div>}
          {result && (
            <pre className="max-h-64 overflow-y-auto rounded bg-muted/30 p-2 font-mono whitespace-pre-wrap text-muted-foreground">
              {result}
            </pre>
          )}
        </div>
      )}
    </ToolShell>
  )
}
