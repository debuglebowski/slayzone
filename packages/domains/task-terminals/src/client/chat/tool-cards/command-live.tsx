import { useLayoutEffect, useRef } from 'react'
import { Button, cn } from '@slayzone/ui'
import type { CommandTaskView } from '@slayzone/terminal/client'
import { useCommandTaskActions, useCommandTaskOutput } from './command-task-hooks'

/**
 * The running part of a command card (Claude's Bash, Codex's commands): the
 * output of a command the CLI runs as a task, polled while it runs, and — where
 * the provider has them — its actions.
 */

export function formatSeconds(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * A command the CLI runs as a task, while it runs: its output (polled — this
 * part only exists while the command runs) and, with `actions`, Move to
 * background / Stop command.
 */
export function RunningTask({
  task,
  toolUseId,
  canBackground,
  actions: withActions = true
}: {
  task: CommandTaskView
  toolUseId: string
  canBackground: boolean
  /** The provider can stop / background a command (Codex can't). */
  actions?: boolean
}) {
  const live = useCommandTaskOutput(task.taskId, true)
  const actions = useCommandTaskActions()
  const output = live && 'output' in live ? live : undefined
  return (
    <>
      {output && output.output && (
        <LiveOutput
          output={output.output}
          totalBytes={output.totalBytes}
          truncated={output.truncated}
        />
      )}
      {withActions && (
        <div className="px-3 pt-1 flex items-center gap-2">
          {!task.backgrounded && canBackground && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={actions.pending}
              onClick={() => actions.background(toolUseId)}
            >
              Move to background
            </Button>
          )}
          {task.backgrounded && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={actions.pending}
              onClick={() => actions.stop(task.taskId)}
            >
              Stop command
            </Button>
          )}
        </div>
      )}
    </>
  )
}

/** The running command's output, kept scrolled to its newest line. */
function LiveOutput({
  output,
  totalBytes,
  truncated
}: {
  output: string
  totalBytes: number
  truncated: boolean
}) {
  const ref = useRef<HTMLPreElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])
  return (
    <div className="px-3 pt-1">
      {truncated && (
        <div className="text-[10px] text-muted-foreground/80 pb-0.5">
          Showing the last 8 KB of {formatBytes(totalBytes)}
        </div>
      )}
      <pre
        ref={ref}
        data-testid="bash-live-output"
        className={cn(
          'text-xs font-mono whitespace-pre-wrap text-muted-foreground max-h-64 overflow-y-auto',
          'rounded bg-muted/30 px-2 py-1'
        )}
      >
        {output}
      </pre>
    </div>
  )
}
