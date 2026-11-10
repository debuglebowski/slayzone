/**
 * Where an automation's shell action runs: on the computer that holds the work —
 * the task's, else the project's — as one `exec.run`. The hub's composition wires
 * {@link setAutomationCommandRouting}; unwired, or with no computer, the action runs
 * on the hub (and a hub with processes switched off refuses it, T-05).
 */

export interface AutomationCommand {
  command: string
  /** Absolute, on the computer; absent = the project's folder there (`projectId`). */
  cwd?: string
  projectId?: string
  timeoutMs: number
}

export interface AutomationCommandResult {
  stdout: string
  stderr: string
  status: number | null
  timedOut: boolean
}

export interface AutomationCommandRouting {
  computerFor(target: { taskId?: string; projectId?: string }): Promise<string | null>
  /** Whether `computerId` is connected and can take work now. Absent = assume so. */
  isReachable?(computerId: string): boolean
  run(computerId: string, command: AutomationCommand): Promise<AutomationCommandResult>
  /**
   * The task's worktree path and custom folder as `computerId` (where its actions run)
   * holds them — `{{task.worktree_path}}` and path conditions (§9 Phase 7c/7d: the hub
   * keeps no task path). Null: the task has none there. Throws when the computer
   * cannot answer — the run then fails rather than use an empty / guessed path.
   */
  taskPaths?(
    computerId: string,
    taskId: string
  ): Promise<{ worktreePath: string | null; baseDir: string | null } | null>
}

let routing: AutomationCommandRouting | null = null

export function setAutomationCommandRouting(next: AutomationCommandRouting | null): void {
  routing = next
}

export function getAutomationCommandRouting(): AutomationCommandRouting | null {
  return routing
}
