import { useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Terminal } from '@slayzone/terminal/client/LazyTerminal'
import { useTRPC } from '@slayzone/transport/client'
import {
  useTerminalModes,
  getVisibleModes,
  getModeLabel,
  groupTerminalModes
} from '@slayzone/terminal'
import type { TerminalMode } from '@slayzone/terminal/shared'
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator
} from '@slayzone/ui'
import { RotateCcw, MoreHorizontal, PictureInPicture2, PictureInPicture, Focus } from 'lucide-react'

export type FloatingStateKind = 'attached' | 'detached' | 'disabled'

interface AgentSidePanelProps {
  width: number
  sessionId: string
  cwd: string
  mode: TerminalMode
  isActive: boolean
  isResizing?: boolean
  onNewSession?: () => void
  onModeChange?: (mode: TerminalMode) => void
  floatingEnabled?: boolean
  onToggleFloating?: () => void
  floatingState?: FloatingStateKind
  onDetach?: () => void
  onReattach?: () => void
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
  onModeChange,
  floatingEnabled,
  onToggleFloating,
  floatingState = 'attached',
  onDetach,
  onReattach
}: AgentSidePanelProps) {
  const { modes } = useTerminalModes()
  const visibleModes = getVisibleModes(modes, mode)
  const { builtin, custom } = groupTerminalModes(visibleModes)

  const trpc = useTRPC()
  const claimSession = useMutation(trpc.app.taskWindows.claimSession.mutationOptions())

  // Multi-window: claim PTY routing when this window becomes active or regains focus.
  // Without this, secondary window mounts AgentSidePanel but PTY output keeps flowing to
  // the previously-bound window. Claim redirects the session + replays buffer here.
  useEffect(() => {
    if (!isActive || !sessionId) return
    claimSession.mutate({ sessionId })
    const onFocus = () => { claimSession.mutate({ sessionId }) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, sessionId])

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
                className="!h-6 min-w-28 px-2 py-0 text-xs"
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
                <Button
                  variant="outline"
                  onClick={onNewSession}
                  aria-label="Clear conversation"
                  className="h-6 w-6 p-0 rounded-md"
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Clear conversation</TooltipContent>
            </Tooltip>
          )}
          {onToggleFloating && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="Floating agent options"
                  className={`h-6 w-6 flex items-center justify-center transition-colors ${
                    floatingEnabled || floatingState === 'detached'
                      ? 'text-primary hover:text-primary/80'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {floatingState === 'detached' ? (
                  <DropdownMenuItem onSelect={() => onReattach?.()}>
                    <PictureInPicture className="size-4 text-muted-foreground" />
                    <span>Reattach</span>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => onDetach?.()}>
                    <PictureInPicture2 className="size-4 text-muted-foreground" />
                    <span>Detach</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={!!floatingEnabled}
                  onCheckedChange={() => onToggleFloating()}
                  className="pl-2 pr-8 [&>span:first-child]:left-auto [&>span:first-child]:right-2"
                >
                  <Focus className="size-4 text-muted-foreground" />
                  <span>Detach on blur</span>
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
