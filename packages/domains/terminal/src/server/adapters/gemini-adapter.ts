import {
  defaultEncodeSubmit,
  type TerminalAdapter,
  type PromptInfo,
  type ActivityState,
  type ErrorInfo,
  type DoctorBinaryRequirement
} from './types'

/**
 * Adapter for Google Gemini.
 * Ink-based TUI with Braille spinner (cli-spinners "dots").
 */
export class GeminiAdapter implements TerminalAdapter {
  readonly mode = 'gemini' as const
  // Ink TUI redraws in bursts; short idle timeout to detect when response is done
  readonly idleTimeoutMs = 2500
  // detectActivity is coarse (any chunk > 50 chars → working). Stay output-
  // driven so small redraw chunks during real work still pin the idle clock
  // open — otherwise Gemini would flip to idle mid-response.
  readonly transitionOnInput = false
  // Gemini's Ink TUI + Node.js bundle takes 7+ seconds to produce first output
  readonly startupTimeoutMs = 20_000
  readonly sessionIdCommand = '/stats'

  encodeSubmit = defaultEncodeSubmit

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '') // CSI sequences
      .replace(/\x1b[()][AB012]/g, '') // Character set
  }

  detectActivity(data: string, _current: ActivityState): ActivityState | null {
    const stripped = GeminiAdapter.stripAnsi(data).trimStart()
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

    if (
      /429|Too Many Requests|exceeded your current quota|Resource has been exhausted/i.test(
        stripped
      )
    ) {
      return {
        code: 'RATE_LIMIT',
        message: 'API rate limit exceeded',
        recoverable: true
      }
    }

    return null
  }

  readonly doctorRequirements: readonly DoctorBinaryRequirement[] = [
    { binary: 'gemini', check: 'Binary found', fix: 'npm install -g @google/gemini-cli' }
  ]

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

  detectConversationId(data: string): string | null {
    const stripped = GeminiAdapter.stripAnsi(data)
    // Try labeled match first
    const labeled = stripped.match(
      /session\s*id:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im
    )
    if (labeled) return labeled[1]
    // Last resort: any UUID in the output
    const bare = stripped.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    return bare ? bare[1] : null
  }
}
