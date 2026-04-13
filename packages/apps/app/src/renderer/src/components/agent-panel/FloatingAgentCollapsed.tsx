import type { TerminalState } from '@slayzone/terminal/shared'

interface Props {
  state: TerminalState
  onExpand: () => void
}

const STATUS_MAP: Record<TerminalState, { color: string; pulse: boolean; text: string }> = {
  starting:  { color: '#fbbf24', pulse: true,  text: 'starting...' },
  running:   { color: '#fbbf24', pulse: true,  text: 'working...' },
  attention: { color: '#4ade80', pulse: false, text: 'waiting for input' },
  error:     { color: '#ef4444', pulse: false, text: 'error' },
  dead:      { color: '#666',    pulse: false, text: 'session ended' },
}

export function FloatingAgentCollapsed({ state, onExpand }: Props) {
  const status = STATUS_MAP[state] ?? STATUS_MAP.dead

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-1 cursor-pointer transition-all duration-150 ease-out hover:brightness-125 active:brightness-100 overflow-hidden">
      {/* Header — draggable */}
      <div
        className="flex items-center px-4 pt-2 pb-1.5 gap-2 border-b border-border select-none w-full"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div
          className={`w-2 h-2 rounded-full shrink-0${status.pulse ? ' animate-pulse' : ''}`}
          style={{ backgroundColor: status.color }}
        />
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest leading-none">Agent</span>
      </div>
      {/* Body — click to expand */}
      <button
        className="flex-1 flex items-center px-4 w-full border-none bg-transparent cursor-pointer"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={onExpand}
      >
        <span className="text-[11px] font-mono text-muted-foreground truncate leading-none">{status.text}</span>
      </button>
    </div>
  )
}
