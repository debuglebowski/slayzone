import { useLayoutEffect, useRef } from 'react'
import { Terminal as TerminalIcon } from 'lucide-react'
import { Button, cn, useNow } from '@slayzone/ui'
import type { CommandTaskView } from '@slayzone/terminal/client'
import { LinkText, ToolShell, resultTextOf, type ToolProps } from './card-shell'
import { useCommandTaskActions, useCommandTaskOutput } from './command-task-hooks'

/** What the card says about the command's task (`data-task-state`). */
type TaskState = 'running' | 'background' | 'exited' | 'stopped'

function taskState(task: CommandTaskView | undefined): TaskState | undefined {
  if (!task) return undefined
  if (task.status === 'running') return task.backgrounded ? 'background' : 'running'
  return task.status === 'killed' ? 'stopped' : 'exited'
}

function formatSeconds(ms: number): string {
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
 * Bash (plan 3.2 / 3.9). The command shows as its input streams; while it runs,
 * a timer — and, once the CLI reports it as a task (a few seconds in), its
 * output as it grows. A background command keeps its live output after its
 * turn, and its final output (read once it ended) stays.
 */
export function BashCard({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { command?: string; description?: string } | null
  const task = invocation.task
  const state = taskState(task)
  const taskRunning = task?.status === 'running'
  // Running = the call has no result yet (a foreground command), or its task runs.
  const running = taskRunning || (!task && invocation.status === 'pending')
  const now = useNow(1000, { enabled: running })
  const startedAt = task?.startedAt ?? timestamp

  const resultText = resultTextOf(invocation)
  // A background command's tool result only says it went to the background:
  // its output is the one read from the CLI when it ended.
  const finalOutput = task?.backgrounded ? (task.finalOutput?.output ?? resultText) : resultText

  return (
    <div data-testid="tool-bash" data-task-state={state}>
      <ToolShell
        icon={<TerminalIcon className="size-3" />}
        title={
          <span className="inline-flex items-center gap-1.5">
            Bash
            {task?.backgrounded && (
              <span className="rounded px-1 py-px text-[10px] font-normal bg-muted text-muted-foreground">
                Background
              </span>
            )}
          </span>
        }
        invocation={invocation}
        timestamp={timestamp}
        summary={input?.description ?? input?.command}
        defaultOpen
      >
        {input?.command && (
          <div className="px-3 pt-2 text-xs font-mono flex items-start gap-2">
            <span className="text-primary shrink-0">$</span>
            <span data-testid="bash-command" className="whitespace-pre-wrap break-all">
              {input.command}
            </span>
          </div>
        )}
        {task && taskRunning && (
          <RunningTask
            task={task}
            toolUseId={invocation.id}
            canBackground={invocation.status === 'pending'}
          />
        )}
        {!running && finalOutput && (
          <pre
            data-testid="bash-output"
            className="px-3 pb-2 pt-1 text-xs font-mono whitespace-pre-wrap text-muted-foreground max-h-64 overflow-y-auto"
          >
            <LinkText text={finalOutput} />
          </pre>
        )}
        {running && startedAt !== undefined && (
          <div className="px-3 pb-2 pt-1 text-[11px] text-muted-foreground tabular-nums">
            Running · <span data-testid="bash-elapsed">{formatSeconds(now - startedAt)}</span>
          </div>
        )}
        {!running && task?.startedAt !== undefined && task.endedAt !== undefined && (
          <div className="px-3 pb-2 text-[11px] text-muted-foreground tabular-nums">
            <span data-testid="bash-duration">
              ran {formatSeconds(task.endedAt - task.startedAt)}
            </span>
          </div>
        )}
      </ToolShell>
    </div>
  )
}

/**
 * A command the CLI runs as a task, while it runs: its output (polled — this
 * part only exists while the command runs) and its actions.
 */
function RunningTask({
  task,
  toolUseId,
  canBackground
}: {
  task: CommandTaskView
  toolUseId: string
  canBackground: boolean
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
