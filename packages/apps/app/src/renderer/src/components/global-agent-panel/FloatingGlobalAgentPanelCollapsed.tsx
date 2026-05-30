import { Maximize2, Frame, X } from 'lucide-react'
import type { TerminalState } from '@slayzone/terminal/shared'

interface Props {
  state: TerminalState
  onExpand: () => void
  onResetSize: () => void
  onClose: () => void
  showClose: boolean
  showReset: boolean
}

const STATUS_MAP: Record<TerminalState, { color: string; pulse: boolean; text: string }> = {
  starting: { color: '#fbbf24', pulse: true, text: 'starting...' },
  running: { color: '#fbbf24', pulse: true, text: 'working...' },
  idle: { color: '#4ade80', pulse: false, text: 'idle' },
  error: { color: '#ef4444', pulse: false, text: 'error' },
  dead: { color: '#666', pulse: false, text: 'session ended' },
  hibernated: { color: '#a78bfa', pulse: false, text: 'paused' }
}

export function FloatingGlobalAgentPanelCollapsed({
  state,
  onExpand,
  onResetSize,
  onClose,
  showClose,
  showReset
}: Props) {
  const status = STATUS_MAP[state] ?? STATUS_MAP.dead

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-1 cursor-pointer transition-all duration-150 ease-out hover:brightness-125 active:brightness-100 overflow-hidden">
      {/* Header — draggable */}
      <div
        className="flex items-center px-4 pt-2.5 pb-2 gap-2 border-b border-border select-none w-full"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div
          className={`w-2.5 h-2.5 rounded-full shrink-0${status.pulse ? ' animate-pulse' : ''}`}
          style={{ backgroundColor: status.color }}
        />
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest leading-none">
          Global Agent
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {showReset && (
            <button
              className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onClick={onResetSize}
              aria-label="Reset size and position"
              title="Reset size & position"
            >
              <Frame className="size-3" />
            </button>
          )}
          <button
            className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={onExpand}
            aria-label="Expand"
            title="Expand"
          >
            <Maximize2 className="size-3" />
          </button>
          {showClose && (
            <button
              className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-red-500/20 hover:text-red-500 transition-colors"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onClick={onClose}
              aria-label="Close (reattach to sidebar)"
              title="Close"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>
      {/* Body — click to expand */}
      <button
        className="flex-1 flex items-center px-4 w-full border-none bg-transparent cursor-pointer"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={onExpand}
      >
        <span className="text-[12px] font-mono text-muted-foreground truncate leading-none">
          {status.text}
        </span>
      </button>
    </div>
  )
}
