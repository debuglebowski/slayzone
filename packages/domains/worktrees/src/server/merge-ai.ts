import { quoteForShell } from '@slayzone/platform'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'

/** The result of one shell command on a computer (`exec.run`). */
export interface AiCommandResult {
  stdout: string
  stderr: string
  status: number | null
  timedOut: boolean
}
/** Null = no computer: refused ("connect a computer"). */
export type AiCommandRunner = (
  command: string,
  timeoutMs: number
) => Promise<AiCommandResult | null>

let runner: AiCommandRunner | null = null

/**
 * Agents run on computers: the hub's composition wires a runner (the caller's
 * computer, one `exec.run`). Unwired or no computer: refused — the hub runs no agent.
 */
export function setAiCommandRunner(next: AiCommandRunner | null): void {
  runner = next
}

const AI_COMMAND_TIMEOUT_MS = 60_000

export async function runAiCommand(mode: 'claude-code' | 'codex', prompt: string): Promise<string> {
  const args =
    mode === 'claude-code' ? ['--print', '--allow-dangerously-skip-permissions', prompt] : [prompt]
  // The binary is the COMPUTER's: `$HOME` expands in its shell, not here.
  const binary = mode === 'claude-code' ? '"$HOME/.local/bin/claude"' : quoteForShell('codex')
  const command = [binary, ...args.map(quoteForShell)].join(' ')
  const result = runner ? await runner(command, AI_COMMAND_TIMEOUT_MS) : null
  if (!result) refuseNoComputer({ op: 'worktrees.analyzeConflict' })
  if (result.timedOut) throw new Error('Timeout')
  if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`)
  return result.stdout.trim()
}
