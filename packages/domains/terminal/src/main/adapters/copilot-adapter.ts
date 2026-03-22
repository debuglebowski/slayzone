import type { TerminalAdapter, PromptInfo, ActivityState, ErrorInfo, ValidationResult } from './types'
import { whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for GitHub Copilot CLI.
 * Copilot CLI is a full-screen TUI; activity is best inferred from input + idle timeout.
 */
export class CopilotAdapter implements TerminalAdapter {
  readonly mode = 'copilot' as const
  readonly idleTimeoutMs = 2500
  readonly transitionOnInput = true

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '') // CSI sequences
      .replace(/\x1b[()][AB012]/g, '') // Character set
  }

  detectActivity(_data: string, _current: ActivityState): ActivityState | null {
    // Copilot's TUI redraw behavior makes output-only detection noisy.
    // We rely on transitionOnInput + idleTimeoutMs in pty-manager.
    return null
  }

  detectError(data: string): ErrorInfo | null {
    const stripped = CopilotAdapter.stripAnsi(data)

    if (/no saved session found with id|no conversation found with (?:session )?id|session .* not found/i.test(stripped)) {
      return {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
        recoverable: false
      }
    }

    if (/not authenticated|authentication failed|please run\s+copilot\s+login|login required|unable to authenticate/i.test(stripped)) {
      return {
        code: 'AUTH_ERROR',
        message: 'Authentication failed',
        recoverable: false
      }
    }

    if (/429|too many requests|rate limit|quota exceeded/i.test(stripped)) {
      return {
        code: 'RATE_LIMIT',
        message: 'Rate limit exceeded',
        recoverable: true
      }
    }

    const errorMatch = stripped.match(/\bERROR:\s*(.+)/i)
    if (errorMatch) {
      return {
        code: 'CLI_ERROR',
        message: errorMatch[1].trim(),
        recoverable: true
      }
    }

    return null
  }

  async validate(): Promise<ValidationResult[]> {
    const [shell, found] = await Promise.all([validateShellEnv(), whichBinary('copilot')])
    const results: ValidationResult[] = []
    if (!shell.ok) results.push(shell)
    results.push({
      check: 'Binary found',
      ok: !!found,
      detail: found ?? 'copilot not found in PATH',
      fix: found ? undefined : 'Install GitHub Copilot CLI from https://docs.github.com/copilot/how-tos/copilot-cli'
    })
    return results
  }

  detectPrompt(data: string): PromptInfo | null {
    const stripped = CopilotAdapter.stripAnsi(data)

    if (/\[Y\/n\]|\[y\/N\]/i.test(stripped)) {
      return {
        type: 'permission',
        text: data,
        position: 0
      }
    }

    if (/(?:^|\n|\r)❯\s*\d+\./m.test(stripped)) {
      return {
        type: 'input',
        text: data,
        position: 0
      }
    }

    const questionMatch = stripped.match(/[^\n]*\?\s*$/m)
    if (questionMatch) {
      return {
        type: 'question',
        text: questionMatch[0].trim(),
        position: data.indexOf(questionMatch[0])
      }
    }

    return null
  }
}
