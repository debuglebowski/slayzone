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
  run(computerId: string, command: AutomationCommand): Promise<AutomationCommandResult>
}

let routing: AutomationCommandRouting | null = null

export function setAutomationCommandRouting(next: AutomationCommandRouting | null): void {
  routing = next
}

export function getAutomationCommandRouting(): AutomationCommandRouting | null {
  return routing
}
