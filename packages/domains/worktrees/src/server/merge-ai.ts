import { homedir, platform } from 'os'
import { quoteForShell } from '@slayzone/platform'
import { hubSpawn } from './exec-async'

/** The result of one shell command on a computer (`exec.run`). */
export interface AiCommandResult {
  stdout: string
  stderr: string
  status: number | null
  timedOut: boolean
}
/** Null = no computer: the CLI runs here (refused where processes are off). */
export type AiCommandRunner = (
  command: string,
  timeoutMs: number
) => Promise<AiCommandResult | null>

let runner: AiCommandRunner | null = null

/**
 * Agents run on computers: the hub's composition wires a runner (the caller's
 * computer, one `exec.run`); unwired, the CLI runs here as before.
 */
export function setAiCommandRunner(next: AiCommandRunner | null): void {
  runner = next
}

const AI_COMMAND_TIMEOUT_MS = 60_000

export async function runAiCommand(mode: 'claude-code' | 'codex', prompt: string): Promise<string> {
  if (runner) {
    const args =
      mode === 'claude-code'
        ? ['--print', '--allow-dangerously-skip-permissions', prompt]
        : [prompt]
    // The binary is the COMPUTER's: `$HOME` expands in its shell, not here.
    const binary = mode === 'claude-code' ? '"$HOME/.local/bin/claude"' : quoteForShell('codex')
    const command = [binary, ...args.map(quoteForShell)].join(' ')
    const result = await runner(command, AI_COMMAND_TIMEOUT_MS)
    if (result) {
      if (result.timedOut) throw new Error('Timeout')
      if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`)
      return result.stdout.trim()
    }
  }
  return new Promise((resolve, reject) => {
    const claudePath = platform() === 'win32' ? 'claude' : `${homedir()}/.local/bin/claude`
    const cmd = mode === 'claude-code' ? claudePath : 'codex'
    const args =
      mode === 'claude-code'
        ? ['--print', '--allow-dangerously-skip-permissions', prompt]
        : [prompt]

    const proc = hubSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let error = ''

    proc.stdout?.on('data', (d) => {
      output += d.toString()
    })
    proc.stderr?.on('data', (d) => {
      error += d.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error(error || `Exit code ${code}`))
    })

    proc.on('error', reject)

    // 60s timeout for conflict analysis
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('Timeout'))
    }, 60000)

    proc.on('close', () => clearTimeout(timeout))
  })
}
