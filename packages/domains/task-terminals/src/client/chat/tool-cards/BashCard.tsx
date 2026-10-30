import { Terminal as TerminalIcon } from 'lucide-react'
import { useNow } from '@slayzone/ui'
import type { CommandTaskView } from '@slayzone/terminal/client'
import { LinkText, ToolShell, resultTextOf, type ToolProps } from './card-shell'
import { RunningTask, formatSeconds } from './command-live'

/** What the card says about the command's task (`data-task-state`). */
type TaskState = 'running' | 'background' | 'exited' | 'stopped'

function taskState(task: CommandTaskView | undefined): TaskState | undefined {
  if (!task) return undefined
  if (task.status === 'running') return task.backgrounded ? 'background' : 'running'
  return task.status === 'killed' ? 'stopped' : 'exited'
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
