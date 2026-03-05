import type { TerminalAdapter, PromptInfo, ActivityState, ErrorInfo, ValidationResult } from './types'
import { whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for Google Gemini.
 * Ink-based TUI with Braille spinner (cli-spinners "dots").
 */
export class GeminiAdapter implements TerminalAdapter {
  readonly mode = 'gemini' as const
  // Ink TUI redraws in bursts; short idle timeout to detect when response is done
  readonly idleTimeoutMs = 2500
  readonly sessionIdCommand = '/stats'

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '')          // CSI sequences
      .replace(/\x1b[()][AB012]/g, '')                       // Character set
  }

  detectActivity(data: string, _current: ActivityState): ActivityState | null {
    const stripped = GeminiAdapter.stripAnsi(data).trimStart()

    // Approval prompt — needs user input
    if (/Approve\?\s*\(y\/n(\/always)?\)/i.test(stripped)) return 'attention'

    // Ink TUI redraws entire screen in bursts during response streaming.
    // Meaningful content (>50 chars after stripping ANSI) indicates active work.
    // Small chunks are idle cursor/redraw noise.
    if (stripped.length > 50) return 'working'

    return null
  }

  detectError(data: string): ErrorInfo | null {
    const stripped = GeminiAdapter.stripAnsi(data)

    if (/GEMINI_API_KEY environment variable not found/i.test(stripped)) {
      return {
        code: 'MISSING_API_KEY',
        message: 'GEMINI_API_KEY not set',
        recoverable: false
      }
    }

    if (/429|Too Many Requests|exceeded your current quota|Resource has been exhausted/i.test(stripped)) {
      return {
        code: 'RATE_LIMIT',
        message: 'API rate limit exceeded',
        recoverable: true
      }
    }

    return null
  }

  async validate(): Promise<ValidationResult[]> {
    const [shell, found] = await Promise.all([validateShellEnv(), whichBinary('gemini')])
    const results: ValidationResult[] = []
    if (!shell.ok) results.push(shell)
    results.push({
      check: 'Binary found',
      ok: !!found,
      detail: found ?? 'gemini not found in PATH',
      fix: found ? undefined : 'npm install -g @google/gemini-cli'
    })
    return results
  }

  detectPrompt(data: string): PromptInfo | null {
    const stripped = GeminiAdapter.stripAnsi(data)

    if (/Approve\?\s*\(y\/n(\/always)?\)/i.test(stripped)) {
      return {
        type: 'permission',
        text: data,
        position: 0
      }
    }

    return null
  }
}
