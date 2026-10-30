import { Folder, Terminal as TerminalIcon } from 'lucide-react'
import { cn, useNow } from '@slayzone/ui'
import { useChatView } from '../ChatViewContext'
import { LinkText, ToolShell, type ToolProps } from './card-shell'
import { RunningTask, formatSeconds } from './command-live'
import { codexCommandView, formatDuration } from './codex-items'

/**
 * A Codex shell command (`commandExecution`): the command (without the shell
 * wrapper Codex runs it in), its folder when not the session's, then — while it
 * runs — a timer and its live output (the command task the driver reports,
 * Claude's Bash path), and once done its exit code, duration and output.
 * Codex can't stop or background one command, so the card has no actions.
 */
export function CodexCommandCard({ invocation, timestamp }: ToolProps) {
  const { cwd: sessionCwd } = useChatView()
  const view = codexCommandView(invocation)
  const task = invocation.task
  const running = task ? task.status === 'running' : view.status === 'running'
  const now = useNow(1000, { enabled: running })
  const startedAt = task?.startedAt ?? timestamp
  const showCwd = view.cwd !== undefined && view.cwd !== sessionCwd
  const failed = view.status === 'failed' || (view.exitCode !== null && view.exitCode !== 0)

  return (
    <div data-testid="tool-codex-command" data-status={view.status}>
      <ToolShell
        icon={<TerminalIcon className="size-3" />}
        title="Shell"
        invocation={invocation}
        timestamp={timestamp}
        summary={view.command}
        defaultOpen
      >
        {view.command && (
          <div className="px-3 pt-2 text-xs font-mono flex items-start gap-2">
            <span className="text-primary shrink-0">$</span>
            <span data-testid="codex-command" className="whitespace-pre-wrap break-all">
              {view.command}
            </span>
          </div>
        )}
        {showCwd && (
          <div
            data-testid="codex-command-cwd"
            className="px-3 pt-1 text-[11px] text-muted-foreground flex items-center gap-1 font-mono"
          >
            <Folder className="size-3 shrink-0" />
            <LinkText text={view.cwd ?? ''} />
          </div>
        )}
        {task && running && (
          <RunningTask
            task={task}
            toolUseId={invocation.id}
            canBackground={false}
            actions={false}
          />
        )}
        {!running && view.output && (
          <pre
            data-testid="codex-command-output"
            className="px-3 pb-2 pt-1 text-xs font-mono whitespace-pre-wrap text-muted-foreground max-h-64 overflow-y-auto"
          >
            <LinkText text={view.output} />
          </pre>
        )}
        <div className="px-3 pb-2 pt-1 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          {running && startedAt !== undefined && (
            <span>
              Running ·{' '}
              <span data-testid="codex-command-elapsed">{formatSeconds(now - startedAt)}</span>
            </span>
          )}
          {view.status === 'declined' && (
            <span data-testid="codex-command-declined" className="text-warning-foreground">
              Declined
            </span>
          )}
          {task?.status === 'killed' && (
            <span data-testid="codex-command-stopped" className="text-warning-foreground">
              Stopped
            </span>
          )}
          {!running && view.exitCode !== null && (
            <span
              data-testid="codex-command-exit"
              className={cn(
                'rounded px-1 py-px font-mono',
                failed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
              )}
            >
              exit {view.exitCode}
            </span>
          )}
          {!running && view.durationMs !== null && (
            <span data-testid="codex-command-duration">{formatDuration(view.durationMs)}</span>
          )}
        </div>
      </ToolShell>
    </div>
  )
}
