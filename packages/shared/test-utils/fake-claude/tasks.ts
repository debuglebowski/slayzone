/**
 * Command tasks for the fake `claude` CLI (plan item 3.9): a Bash (or Monitor)
 * command the CLI runs as a task, as 2.1.312 plays it (spike item 14). The
 * `task` step drives `system/task_*` events and answers the app's
 * `get_task_output` / `stop_task` / `background_tasks` control requests; the
 * runtime lives in fake-claude-tasks.mjs.
 *
 * @module test-utils/fake-claude/tasks
 */
import type { Step } from './scenario'

/** A command the CLI runs as a task. The scenario emits its `tool_use` first. */
export interface CommandTaskSpec {
  /** The CLI's task id (e.g. `b00m4bxr8`). */
  taskId: string
  /** The `tool_use` (Bash / Monitor) this task runs. */
  toolUseId: string
  description?: string
  /**
   * `run_in_background: true`: `task_started` at once with `is_backgrounded`,
   * the tool_result says "running in background", the step returns and the
   * command keeps running past the turn.
   */
  background?: boolean
  /**
   * ms from the step's start to `task_started` for a foreground command. The
   * real CLI waits ~3 s (shorter commands never become tasks). Default 300.
   */
  startAfterMs?: number
  /** Output the command prints: each chunk is appended `atMs` after the step starts. */
  output: Array<{ atMs: number; text: string }>
  /** When the command exits, ms after the step starts. Default: last chunk + 100. */
  endAtMs?: number
  /** Default 0. */
  exitCode?: number
  /** `task_type`. Default `local_bash`. */
  taskType?: string
  /**
   * Steps the CLI plays by itself once a BACKGROUND task has finished (the real
   * CLI starts a turn of its own to tell the model). Not tied to a user message.
   */
  afterBackgroundExit?: Step[]
}

/** The step that runs a command task. */
export function taskStep(spec: CommandTaskSpec): Step {
  return { task: spec }
}
