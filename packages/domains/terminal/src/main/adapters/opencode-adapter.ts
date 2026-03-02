import type { TerminalAdapter, SpawnResult, PromptInfo, CodeMode, ActivityState, ErrorInfo, ValidationResult } from './types'
import { buildExecCommand, getShellStartupArgs, resolveUserShell, whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for OpenCode CLI.
 * Bubble Tea (Go) full-screen TUI — spawned via shell + postSpawnCommand like Codex.
 */
export class OpencodeAdapter implements TerminalAdapter {
  readonly mode = 'opencode' as const
  // Bubble Tea TUI updates in many small chunks; short idle timeout for completion
  readonly idleTimeoutMs = 2500
  // Full-screen TUI constantly redraws — detect working from user input, not output
  readonly transitionOnInput = true

  buildSpawnConfig(_cwd: string, conversationId?: string, resuming?: boolean, _initialPrompt?: string, providerArgs: string[] = [], _codeMode?: CodeMode): SpawnResult {
    const cmdArgs: string[] = []

    if (conversationId && resuming) {
      cmdArgs.push('--session', conversationId)
    }

    cmdArgs.push(...providerArgs)

    const shell = resolveUserShell()
    return {
      config: {
        shell,
        args: getShellStartupArgs(shell),
        postSpawnCommand: buildExecCommand('opencode', cmdArgs),
      },
      binary: { name: 'opencode', args: cmdArgs }
    }
  }

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '')          // CSI sequences
      .replace(/\x1b[()][AB012]/g, '')                       // Character set
  }

  detectActivity(_data: string, _current: ActivityState): ActivityState | null {
    // Activity detected via transitionOnInput + idle timeout.
    // Output-based detection unreliable for Bubble Tea TUI that redraws constantly.
    return null
  }

  detectError(data: string): ErrorInfo | null {
    const stripped = OpencodeAdapter.stripAnsi(data)

    if (/Missing API key|Incorrect API key/i.test(stripped)) {
      return {
        code: 'AUTH_ERROR',
        message: 'API key missing or incorrect',
        recoverable: false
      }
    }

    if (/Unauthorized|Authentication Fails/i.test(stripped)) {
      return {
        code: 'AUTH_ERROR',
        message: 'Authentication failed',
        recoverable: false
      }
    }

    return null
  }

  async validate(): Promise<ValidationResult[]> {
    const [shell, found] = await Promise.all([validateShellEnv(), whichBinary('opencode')])
    const results: ValidationResult[] = []
    if (!shell.ok) results.push(shell)
    results.push({
      check: 'Binary found',
      ok: !!found,
      detail: found ?? 'opencode not found in PATH',
      fix: found ? undefined : 'curl -fsSL https://opencode.ai/install | sh'
    })
    return results
  }

  detectPrompt(_data: string): PromptInfo | null {
    // OpenCode TUI uses keyboard controls (a=Allow, d=Deny) rather than text prompts
    // TODO: Detect permission overlay if possible
    return null
  }
}
