import type { CommandInfo } from '@slayzone/terminal-contracts'

/** Menu row for a CLI-run custom command: name, argument hint, origin, description. */
export function renderCliCustomCommandItem(cmd: CommandInfo): React.JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs shrink-0">/{cmd.name}</span>
          {cmd.argumentHint && (
            <span className="font-mono text-[11px] text-muted-foreground truncate">
              {cmd.argumentHint}
            </span>
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide">
            {cmd.source === 'project' ? 'project cmd' : 'user cmd'}
          </span>
        </div>
        {cmd.description && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {cmd.description.split('\n')[0]}
          </div>
        )}
      </div>
    </div>
  )
}
