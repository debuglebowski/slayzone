import { Terminal } from '@slayzone/terminal/client/Terminal'
import {
  useTerminalModes,
  getVisibleModes,
  getModeLabel,
  groupTerminalModes
} from '@slayzone/terminal'
import type { TerminalMode } from '@slayzone/terminal/shared'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { RotateCcw } from 'lucide-react'

interface AgentSidePanelProps {
  width: number
  sessionId: string
  cwd: string
  mode: TerminalMode
  isActive: boolean
  isResizing?: boolean
  onNewSession?: () => void
  onModeChange?: (mode: TerminalMode) => void
}

export const AGENT_PANEL_MIN_WIDTH = 320
export const AGENT_PANEL_MAX_WIDTH = 720

export function AgentSidePanel({
  width,
  sessionId,
  cwd,
  mode,
  isActive,
  isResizing,
  onNewSession,
  onModeChange
}: AgentSidePanelProps) {
  const { modes } = useTerminalModes()
  const visibleModes = getVisibleModes(modes, mode)
  const { builtin, custom } = groupTerminalModes(visibleModes)

  return (
    <div className="relative h-full rounded-md bg-surface-1 border border-border overflow-hidden flex flex-col" style={{ width }}>
      <div className="flex items-center shrink-0 h-10 px-2 gap-2 border-b border-border bg-surface-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Agent</span>
        <div className="ml-auto flex items-center gap-2">
          {onModeChange && (
            <Select
              value={mode}
              onValueChange={(value) => {
                if (modes.some(m => m.id === value)) onModeChange(value as TerminalMode)
              }}
            >
              <SelectTrigger
                data-testid="agent-panel-mode-trigger"
                size="sm"
                className="!h-6 min-w-28 px-2 py-0 text-xs bg-neutral-100 border-neutral-300 dark:bg-neutral-800 dark:border-neutral-700"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end" className="min-w-[var(--radix-select-trigger-width)] max-h-none">
                {builtin.map(m => (
                  <SelectItem key={m.id} value={m.id}>
                    {getModeLabel(m)}
                  </SelectItem>
                ))}
                {custom.length > 0 && builtin.length > 0 && <SelectSeparator />}
                {custom.map(m => (
                  <SelectItem key={m.id} value={m.id}>
                    {getModeLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {onNewSession && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onNewSession}
                  aria-label="Clear conversation"
                  className="h-6 w-6 flex items-center justify-center rounded-md border text-foreground bg-neutral-100 border-neutral-300 hover:bg-neutral-200 dark:bg-neutral-800 dark:border-neutral-700 dark:hover:bg-neutral-700 transition-colors"
                >
                  <RotateCcw className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Clear conversation</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {isResizing ? (
          <div className="h-full bg-black" />
        ) : (
          <Terminal
            key={sessionId}
            sessionId={sessionId}
            cwd={cwd}
            mode={mode}
            isActive={isActive}
          />
        )}
      </div>
    </div>
  )
}
