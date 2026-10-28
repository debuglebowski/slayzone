import type { AgentInfo } from '@slayzone/terminal-contracts'

export function renderAgentItem(agent: AgentInfo): React.JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">@{agent.name}</span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            {agent.source === 'project' ? 'project agent' : 'user agent'}
          </span>
        </div>
        {agent.description && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {agent.description.split('\n')[0]}
          </div>
        )}
      </div>
    </div>
  )
}
