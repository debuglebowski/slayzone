import type { TerminalAdapter, SpawnResult, PromptInfo, CodeMode, ActivityState, ErrorInfo, ValidationResult } from './types'
import { buildExecCommand, getShellStartupArgs, resolveUserShell, whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for Cursor Agent CLI.
 * Proprietary TUI — activity detection is minimal, to be refined with usage.
 */
export class CursorAdapter implements TerminalAdapter {
  readonly mode = 'cursor-agent' as const
  // Ink TUI redraws in bursts; short idle timeout to detect when response is done
  readonly idleTimeoutMs = 2500
  // Full-screen TUI constantly redraws — detect working from user input, not output
  readonly transitionOnInput = true

  buildSpawnConfig(_cwd: string, conversationId?: string, resuming?: boolean, initialPrompt?: string, providerArgs: string[] = [], _codeMode?: CodeMode): SpawnResult {
    const args: string[] = []

    if (resuming && conversationId) {
      args.push('--resume', conversationId)
    }

    args.push(...providerArgs)

    if (initialPrompt) {
      args.push(initialPrompt)
    }

    const shell = resolveUserShell()
    return {
      config: {
        shell,
        args: getShellStartupArgs(shell),
        postSpawnCommand: buildExecCommand('cursor-agent', args),
      },
      binary: { name: 'cursor-agent', args }
    }
  }

  detectActivity(_data: string, _current: ActivityState): ActivityState | null {
    // Activity detected via transitionOnInput + idle timeout.
    // Output-based detection unreliable for proprietary Ink TUI that redraws constantly.
    return null
  }

  detectError(data: string): ErrorInfo | null {
    const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

    if (/Unauthorized User|invalid API key/i.test(stripped)) {
      return {
        code: 'AUTH_ERROR',
        message: 'Authentication failed',
        recoverable: false
      }
    }

    if (/Rate limit exceeded/i.test(stripped)) {
      return {
        code: 'RATE_LIMIT',
        message: 'Rate limit exceeded',
        recoverable: true
      }
    }

    return null
  }

  async validate(): Promise<ValidationResult[]> {
    const [shell, found] = await Promise.all([validateShellEnv(), whichBinary('cursor-agent')])
    const results: ValidationResult[] = []
    if (!shell.ok) results.push(shell)
    results.push({
      check: 'Binary found',
      ok: !!found,
      detail: found ?? 'cursor-agent not found in PATH',
      fix: found ? undefined : 'Enable via Cursor settings → Background Agent'
    })
    return results
  }

  detectPrompt(_data: string): PromptInfo | null {
    // TODO: Implement once prompt format is known
    return null
  }
}
