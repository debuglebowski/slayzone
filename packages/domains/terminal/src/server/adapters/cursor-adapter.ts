import {
  defaultEncodeSubmit,
  type TerminalAdapter,
  type PromptInfo,
  type ActivityState,
  type ErrorInfo,
  type DoctorBinaryRequirement
} from './types'

/**
 * Adapter for Cursor Agent CLI.
 * Proprietary TUI — activity detection is minimal, to be refined with usage.
 */
export class CursorAdapter implements TerminalAdapter {
  readonly mode = 'cursor-agent' as const
  // Ink TUI redraws in bursts; short idle timeout to detect when response is done
  readonly idleTimeoutMs = 2500

  encodeSubmit = defaultEncodeSubmit

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

  readonly doctorRequirements: readonly DoctorBinaryRequirement[] = [
    {
      binary: 'cursor-agent',
      check: 'Binary found',
      fix: 'Enable via Cursor settings → Background Agent'
    }
  ]

  detectPrompt(_data: string): PromptInfo | null {
    // TODO: Implement once prompt format is known
    return null
  }
}
