import type {
  TerminalAdapter,
  PromptInfo,
  ActivityState,
  ErrorInfo,
  ValidationResult
} from './types'
import { whichBinary, validateShellEnv } from '../shell-env'
import { KITTY_SHIFT_ENTER, ENTER } from '@slayzone/terminal/shared'

/**
 * Adapter for Claude Code CLI.
 *
 * State source: Claude Code hooks (SessionStart, UserPromptSubmit, PreToolUse,
 * Stop, Notification, ...) installed by `claude-hook-installer` and forwarded
 * via `notify.sh` → `POST /api/agent-hook` → state machine. The legacy
 * bullet-glyph regex (SPINNER_LINE_RE / COMPLETION_LINE_RE) was retired —
 * `detectActivity` is now intentionally a no-op for this adapter.
 *
 * No silence-timer fallback: hooks + the interrupt marker (see detectActivity)
 * are the sole running→idle signals. idleTimeoutMs = Infinity disables the
 * inactivity checker for this adapter.
 */
export class ClaudeAdapter implements TerminalAdapter {
  readonly mode = 'claude-code' as const
  // No silence-timer fallback. Hooks (Stop/Notification/SessionEnd) drive
  // running→idle; the interrupt marker in detectActivity covers the one
  // hook-less case (ESC mid-thinking). A time-based fallback only ever
  // misfired here — a long Bash run or "thinking" gap tripped a false
  // running→idle mid-turn → spurious needs_attention. Infinity makes the
  // inactivity checker skip this adapter (shouldFlipToIdle is always false).
  readonly idleTimeoutMs = Infinity

  /** Claude Code enables Kitty keyboard protocol; internal newlines must be
   *  encoded as Shift+Enter so they're treated as newline-in-input (not submit). */
  encodeSubmit(text: string): string {
    return text.replace(/[\r\n]+$/, '').replace(/\n/g, KITTY_SHIFT_ENTER) + ENTER
  }

  /**
   * Activity detection is hook-driven for the working→idle path — see
   * `rest-api/agent-hook.ts` and `notify.sh`. The ONE exception is the
   * user-interrupt path: claude does NOT fire the `Stop` hook when the user
   * presses ESC during the pure thinking phase (no tool call in flight),
   * confirmed via diagnostic trace. Without an output signal the spinner
   * would stick on 'running' indefinitely — there is no silence-timer fallback.
   *
   * Claude's TUI prints `⎿  Interrupted · What should Claude do instead?`
   * (with the box-drawing ⎿ glyph, U+23BF) immediately after the user
   * interrupts. We match that marker — anchored on the glyph + literal
   * "Interrupted" — and return `'idle'` so the state machine flips
   * `running → idle` via the existing `activityToTerminalState` path.
   *
   * Architectural debt: deliberately reintroduces narrow output parsing
   * after we retired the bullet-glyph spinner regex. Justified because
   * (a) hooks fail upstream, (b) there is no silence-timer fallback, (c) signal
   * is evidence-based (claude actually printed it), (d) scope is one regex,
   * one direction. Remove if Anthropic fixes Stop-on-ESC. Tracking:
   * https://github.com/anthropics/claude-code/issues (TODO: file).
   */
  detectActivity(data: string, _current: ActivityState): ActivityState | null {
    const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    if (/⎿\s+Interrupted/.test(stripped)) return 'idle'
    return null
  }

  detectError(data: string): ErrorInfo | null {
    // Session not found error
    if (/No conversation found with session ID:/.test(data)) {
      return {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
        recoverable: false
      }
    }

    // Generic CLI error - only match actual error lines, not code/docs
    // Must start with "Error:" at line start (after ANSI codes)
    const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    const errorMatch = stripped.match(/^Error:\s*(.+)/im)
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
    const [shell, found] = await Promise.all([validateShellEnv(), whichBinary('claude')])
    const results: ValidationResult[] = []
    if (!shell.ok) results.push(shell)
    results.push({
      check: 'Binary found',
      ok: !!found,
      detail: found ?? 'claude not found in PATH',
      fix: found ? undefined : 'npm install -g @anthropic-ai/claude-code'
    })
    return results
  }

  detectPrompt(data: string): PromptInfo | null {
    const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

    // Y/n permission prompts
    if (/\[Y\/n\]|\[y\/N\]/i.test(stripped)) {
      return {
        type: 'permission',
        text: data,
        position: 0
      }
    }

    // Numbered menu with selection indicator (Claude's AskUserQuestion)
    if (/(?:^|\n|\r)❯\s*\d+\./m.test(stripped)) {
      return {
        type: 'input',
        text: data,
        position: 0
      }
    }

    // Question detection (lines ending with ?)
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
