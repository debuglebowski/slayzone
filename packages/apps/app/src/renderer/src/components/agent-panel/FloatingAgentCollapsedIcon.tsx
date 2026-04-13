import { TerminalSquare } from 'lucide-react'
import type { TerminalState } from '@slayzone/terminal/shared'

interface Props {
  state: TerminalState
  onExpand: () => void
}

const DOT_COLORS: Record<TerminalState, string> = {
  starting:  '#fbbf24',
  running:   '#fbbf24',
  attention: '#4ade80',
  error:     '#ef4444',
  dead:      '#666',
}

export function FloatingAgentCollapsedIcon({ state, onExpand }: Props) {
  const color = DOT_COLORS[state] ?? DOT_COLORS.dead
  const pulse = state === 'starting' || state === 'running'

  return (
    <button
      className="h-screen w-screen flex items-center justify-center rounded-xl border border-border bg-surface-1 cursor-pointer hover:bg-surface-2 transition-colors relative"
      onClick={onExpand}
    >
      <TerminalSquare size={20} className="text-muted-foreground" />
      <div
        className={`absolute top-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-surface-1${pulse ? ' animate-pulse' : ''}`}
        style={{ backgroundColor: color }}
      />
    </button>
  )
}
