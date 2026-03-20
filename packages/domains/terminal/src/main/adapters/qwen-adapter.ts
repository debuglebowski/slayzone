import type { TerminalAdapter, PromptInfo, ActivityState, ErrorInfo, ValidationResult } from './types'
import { whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for Qwen Code CLI (Alibaba).
 * Fork of Claude Code — shares identical session flags (--session-id, --resume, --yolo).
 *
 * Note: SlayZone uses `--session-id` when starting a *new* session and `--resume` when resuming.
 * If Qwen ever changes `--session-id` semantics to mean "resume only", initial launches would fail.
 *
 * Qwen uses braille spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) instead of Claude's symbols.
 */
export class QwenAdapter implements TerminalAdapter {
  readonly mode = 'qwen-code' as const
  readonly idleTimeoutMs = null // default 60 s

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\]([^\x07\x1b]|\x1b(?!\\))*(\x07|\x1b\\|\x9c)/g, '') // OSC sequences (BEL or ST)
      .replace(/\x1b\[[?0-9;]*[A-Za-z]/g, '') // CSI sequences
      .replace(/\x1b[()][AB012]/g, '') // Character set
      .trimStart()
  }

  detectActivity(data: string, _current: ActivityState): ActivityState | null {
    const s = QwenAdapter.stripAnsi(data)

    // Attention: interactive menus / prompts (identical to Claude Code)
    if (/(?:^|\n|\r)❯\s*\d+\./.test(s)) return 'attention'
    if (/(?:^|\n|\r)❯[A-Za-z]/.test(s)) return 'attention'
    if (/\[Y\/n\]|\[y\/N\]/i.test(s)) return 'attention'
    if (/(?:^|\n|\r)❯\s/.test(s)) return 'attention'

    // Attention: spinner + completion summary (e.g. "⠏ for 2m 30s")
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*\bfor \d+[smh]/m.test(s)) return 'attention'

    // Working: braille spinner character at line start (active generation)
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/m.test(s)) return 'working'

    return null
  }

  detectError(data: string): ErrorInfo | null {
    if (/No conversation found with session ID:/.test(data)) {
      return { code: 'SESSION_NOT_FOUND', message: 'Session not found', recoverable: false }
    }

    const s = QwenAdapter.stripAnsi(data)

    if (/authentication.*failed|not authenticated|please.*log in/i.test(s)) {
      return {
        code: 'NOT_AUTHENTICATED',
        message: 'Not authenticated — run `qwen` once to log in',
        recoverable: false,
      }
    }

    if (/429|Too Many Requests|rate.?limit|quota exceeded/i.test(s)) {
      return { code: 'RATE_LIMIT', message: 'API rate limit exceeded', recoverable: true }
    }

    const errorMatch = s.match(/^Error:\s*(.+)/im)
    if (errorMatch) {
      return { code: 'CLI_ERROR', message: errorMatch[1].trim(), recoverable: true }
    }

    return null
  }

  detectPrompt(data: string): PromptInfo | null {
    const s = QwenAdapter.stripAnsi(data)

    if (/\[Y\/n\]|\[y\/N\]/i.test(s)) {
      return { type: 'permission', text: data, position: 0 }
    }
    if (/(?:^|\n|\r)❯\s*\d+\./m.test(s)) {
      return { type: 'input', text: data, position: 0 }
    }
    const q = s.match(/[^\n]*\?\s*$/m)
    if (q) {
      return { type: 'question', text: q[0].trim(), position: data.indexOf(q[0]) }
    }
    return null
  }

  async validate(): Promise<ValidationResult[]> {
    const [shell, found] = await Promise.all([validateShellEnv(), whichBinary('qwen')])
    const results: ValidationResult[] = []
    if (!shell.ok) results.push(shell)
    results.push({
      check: 'Binary found',
      ok: !!found,
      detail: found ?? 'qwen not found in PATH',
      fix: found ? undefined : 'Install qwen-code (e.g. npm install -g @qwen-code/qwen-code)',
    })
    return results
  }
}
