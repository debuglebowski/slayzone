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
 * No silence-timer fallback: hooks drive running→idle, and the one hook-less
 * case (no Stop hook fires on user interrupt) is handled at the input layer
 * (Terminal `onKey` → `pty.interrupt`). idleTimeoutMs = Infinity disables the
 * inactivity checker for this adapter.
 */
export class ClaudeAdapter implements TerminalAdapter {
  readonly mode = 'claude-code' as const
  // No silence-timer fallback. Hooks (Stop/Notification/SessionEnd) drive
  // running→idle; the one hook-less case (user interrupt via Esc/Ctrl+C, which
  // fires no Stop hook) is handled at the input layer (Terminal `onKey` →
  // `pty.interrupt`). A time-based fallback only ever misfired here — a long
  // Bash run or "thinking" gap tripped a false running→idle mid-turn →
  // spurious needs_attention. Infinity makes the inactivity checker skip this
  // adapter (shouldFlipToIdle is always false).
  readonly idleTimeoutMs = Infinity
  // Fully hook-driven (see HOOK_DRIVEN_MODES): skips the optimistic
  // Enter→'running' flip. A local slash command (/status) fires no hook and
  // Infinity leaves no silence-timer to undo a wrong flip → stuck-running.
  readonly hookDriven = true

  /** Claude Code enables Kitty keyboard protocol; internal newlines must be
   *  encoded as Shift+Enter so they're treated as newline-in-input (not submit). */
  encodeSubmit(text: string): string {
    return text.replace(/[\r\n]+$/, '').replace(/\n/g, KITTY_SHIFT_ENTER) + ENTER
  }

  /**
   * No output-based activity detection — Claude is fully hook-driven for the
   * working→idle path (see `rest-api/agent-hook.ts` + `notify.sh`). The one
   * hook-less case, user interrupt (Esc/Ctrl+C fires no `Stop` hook), is handled
   * where the keypress happens: Terminal's `onKey` → `pty.interrupt` → backend
   * flips running→idle (mirrors Superset's `useTerminalInterruptClear`).
   *
   * A `⎿ Interrupted` output regex previously lived here as a fallback, but it
   * was unreliable: claude draws that line with cursor positioning, so it
   * arrived split across PTY chunks and usually never matched. The input-layer
   * handler is the reliable signal, so this is now a no-op.
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
