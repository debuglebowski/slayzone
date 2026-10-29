import {
  defaultEncodeSubmit,
  type TerminalAdapter,
  type PromptInfo,
  type ActivityState,
  type ErrorInfo,
  type DoctorBinaryRequirement
} from './types'

/**
 * Adapter for OpenCode CLI.
 * Bubble Tea (Go) full-screen TUI — spawned via shell + exec like Codex.
 */
export class OpencodeAdapter implements TerminalAdapter {
  readonly mode = 'opencode' as const
  // Bubble Tea TUI updates in many small chunks; short idle timeout for completion
  readonly idleTimeoutMs = 2500

  encodeSubmit = defaultEncodeSubmit

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '') // CSI sequences
      .replace(/\x1b[()][AB012]/g, '') // Character set
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

  readonly doctorRequirements: readonly DoctorBinaryRequirement[] = [
    {
      binary: 'opencode',
      check: 'Binary found',
      fix: 'curl -fsSL https://opencode.ai/install | sh'
    }
  ]

  detectPrompt(_data: string): PromptInfo | null {
    // OpenCode TUI uses keyboard controls (a=Allow, d=Deny) rather than text prompts
    // TODO: Detect permission overlay if possible
    return null
  }
}
