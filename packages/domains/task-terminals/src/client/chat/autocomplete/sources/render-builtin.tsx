import type { BuiltinCommand } from '../types'

export function renderBuiltinItem(cmd: BuiltinCommand): React.JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">/{cmd.name}</span>
          <span className="text-3xs text-muted-foreground uppercase tracking-wide">
            built-in
          </span>
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">{cmd.description}</div>
      </div>
    </div>
  )
}
