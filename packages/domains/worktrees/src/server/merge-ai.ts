import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'

/** The result of one shell command on a computer (`exec.run`). */
export interface AiCommandResult {
  stdout: string
  stderr: string
  status: number | null
  timedOut: boolean
}
/** Null = no computer: refused ("connect a computer"). */
/** A program and its args, resolved and run on the computer with no shell. */
export interface AiProgram {
  file: string
  args: string[]
  /** The prompt: by stdin, never argv — a Windows cmd line ends at its first newline. */
  stdin?: string
  /** Home-relative places to look when `file` is not on the computer's PATH. */
  homeFallbacks?: string[]
}

export type AiCommandRunner = (
  program: AiProgram,
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
  // The computer resolves the binary (its PATH, else its own ~/.local/bin/claude)
  // and runs it with no shell: no quoting or `$HOME` built here for another OS.
  const program: AiProgram =
    mode === 'claude-code'
      ? {
          file: 'claude',
          // `--print` with no prompt argument reads it from stdin.
          args: ['--print', '--allow-dangerously-skip-permissions'],
          stdin: prompt,
          homeFallbacks: ['.local/bin/claude']
        }
      : // Headless, as the codex agent mode runs it; `-`: the prompt from stdin.
        { file: 'codex', args: ['exec', '-'], stdin: prompt }
  const result = runner ? await runner(program, AI_COMMAND_TIMEOUT_MS) : null
  if (!result) refuseNoComputer({ op: 'worktrees.analyzeConflict' })
  if (result.timedOut) throw new Error('Timeout')
  if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`)
  return result.stdout.trim()
}
