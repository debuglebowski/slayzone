import type { TerminalAdapter, PromptInfo, ActivityState, ErrorInfo, ValidationResult } from './types'
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
 * The silence timer (idleTimeoutMs) remains as a safety net for missed hooks.
 */
export class ClaudeAdapter implements TerminalAdapter {
  readonly mode = 'claude-code' as const
  // Fail-safe for fully dropped hooks (e.g. user disabled the SlayZone entry
  // in ~/.claude/settings.json, or notify.sh is missing). With hooks driving
  // every transition AND refreshing the clock on each fire, the silence
  // timer only matters when no hook lands for this entire window — which
  // would only happen for an unhooked claude or one stuck on a single tool
  // with no progress signal for 5+ minutes. 5s (the old TUI value) was way
  // too tight: a single long Bash or "thinking" gap >5s tripped a false
  // running→idle mid-turn → spurious needs_attention flag.
  readonly idleTimeoutMs = 5 * 60 * 1000

  /** Claude Code enables Kitty keyboard protocol; internal newlines must be
   *  encoded as Shift+Enter so they're treated as newline-in-input (not submit). */
  encodeSubmit(text: string): string {
    return text.replace(/[\r\n]+$/, '').replace(/\n/g, KITTY_SHIFT_ENTER) + ENTER
  }

  /**
   * Activity detection is delegated to Claude Code hooks — see
   * `rest-api/agent-hook.ts` and `notify.sh`. This method exists only to
   * satisfy the `TerminalAdapter` interface contract.
   */
  detectActivity(_data: string, _current: ActivityState): ActivityState | null {
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
