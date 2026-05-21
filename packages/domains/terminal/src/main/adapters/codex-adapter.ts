import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  defaultEncodeSubmit,
  type TerminalAdapter,
  type PromptInfo,
  type ActivityState,
  type ErrorInfo,
  type ValidationResult
} from './types'
import { whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for OpenAI Codex.
 *
 * State source: Codex's native hooks system (SessionStart, UserPromptSubmit,
 * PreToolUse, Stop, PermissionRequest) installed by `codex-hook-installer` and
 * forwarded via `notify.sh` → `POST /api/agent-hook` → state machine. The
 * legacy "esc to interrupt" working-indicator regex was retired —
 * `detectActivity` only handles the approval-modal exception now.
 *
 * No silence-timer fallback: hooks + the approval-modal detection are the
 * sole running→idle signals. idleTimeoutMs = Infinity disables the inactivity
 * checker for this adapter.
 */
export class CodexAdapter implements TerminalAdapter {
  readonly mode = 'codex' as const
  // No silence-timer fallback — mirrors ClaudeAdapter. Hooks drive every
  // running→idle transition; the approval-modal check in detectActivity
  // covers the lagging-hook case. A time-based fallback only misfired: a
  // quiet "thinking" gap tripped a false running→idle mid-turn → spurious
  // needs_attention. Infinity makes the inactivity checker skip this adapter.
  //
  // `transitionOnInput` is left at the TUI default (like ClaudeAdapter):
  // Enter flips to 'running' for instant feedback before the
  // UserPromptSubmit hook lands.
  readonly idleTimeoutMs = Infinity
  readonly sessionIdCommand = '/status'

  encodeSubmit = defaultEncodeSubmit

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '') // CSI sequences
      .replace(/\x1b[()][AB012]/g, '') // Character set
  }

  private static normalizeText(data: string): string {
    return data.replace(/\s+/g, ' ').trim()
  }

  /**
   * Detect a codex approval modal.
   *
   * Signal anchors on stable Rust string literals from `codex-rs/tui/src/bottom_pane/
   * approval_overlay.rs` and `onboarding/trust_directory.rs` (codex 0.130+):
   *
   *   - Numbered options row: `  1. Yes`, `  2. No, ...`
   *   - Deny label literal: `No, and tell Codex what to do differently` (appears in
   *     exec / patch / permissions kinds — most stable per-kind invariant)
   *   - Built-in title strings (covers trust + MCP elicit which lack the deny label)
   *
   * The visible title line may be model-generated ("Allow X to Y?") and is NOT
   * reliable on its own — so we require `numbered` AND (`deny` OR `title`).
   */
  private static hasApprovalModal(text: string): boolean {
    const hasNumbered = /(?:^|\s)\d+\.\s+(?:Yes|No)\b/i.test(text)
    if (!hasNumbered) return false
    const hasDeny = /\bNo,\s+and\s+tell\s+Codex\b/i.test(text)
    if (hasDeny) return true
    return /\b(?:Would\s+you\s+like\s+to\s+(?:run|grant|make)|Do\s+you\s+(?:want\s+to\s+approve|trust\s+the\s+contents)|needs\s+your\s+approval)/i.test(
      text
    )
  }

  /**
   * Activity detection is hook-driven (UserPromptSubmit / PreToolUse → running,
   * Stop → idle — see `rest-api/agent-hook.ts`). The ONE output signal kept is
   * the approval modal: a synchronous TUI modal that acts as the fallback when
   * the `PermissionRequest` hook lags or hooks are untrusted — flips
   * running→idle immediately rather than waiting on the lagging hook.
   */
  detectActivity(data: string, _current: ActivityState): ActivityState | null {
    const stripped = CodexAdapter.normalizeText(CodexAdapter.stripAnsi(data))
    if (CodexAdapter.hasApprovalModal(stripped)) return 'idle'
    return null
  }

  detectError(_data: string): ErrorInfo | null {
    const stripped = CodexAdapter.stripAnsi(_data)

    // Codex resume session not found variants.
    if (
      /no saved session found with id/i.test(stripped) ||
      /no conversation found with (?:session )?id/i.test(stripped) ||
      /session \S+ not found/i.test(stripped)
    ) {
      return {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
        recoverable: false
      }
    }

    // Generic CLI error.
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
    const [shell, node, codex] = await Promise.all([
      validateShellEnv(),
      whichBinary('node'),
      whichBinary('codex')
    ])
    const results: ValidationResult[] = []
    if (!shell.ok) results.push(shell)
    results.push(
      {
        check: 'Node.js found',
        ok: !!node,
        detail: node ?? 'node not found in PATH',
        fix: node ? undefined : 'Install Node.js from https://nodejs.org'
      },
      {
        check: 'Codex found',
        ok: !!codex,
        detail: codex ?? 'codex not found in PATH',
        fix: codex ? undefined : 'npm install -g @openai/codex'
      }
    )
    return results
  }

  /**
   * Detect session ID from Codex's local session files.
   * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<UUID>.jsonl.
   * We find the file created after our spawn time whose cwd matches the task's
   * working directory, then extract the UUID from its name.
   */
  /**
   * Detect session ID from Codex's local session files.
   * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<UUID>.jsonl.
   * We find the file created after our spawn time whose cwd matches the task's
   * working directory, then extract the UUID from its name.
   */
  async detectSessionFromDisk(spawnedAt: number, cwd: string): Promise<string | null> {
    const now = new Date()
    // Try both UTC and local date (Codex may use either)
    const datePaths = [
      {
        y: now.getUTCFullYear(),
        m: now.getUTCMonth() + 1,
        d: now.getUTCDate()
      },
      {
        y: now.getFullYear(),
        m: now.getMonth() + 1,
        d: now.getDate()
      }
    ]

    for (const dp of datePaths) {
      const dir = join(
        homedir(),
        '.codex',
        'sessions',
        String(dp.y),
        String(dp.m).padStart(2, '0'),
        String(dp.d).padStart(2, '0')
      )

      try {
        const files = (await readdir(dir))
          .filter((f) => f.endsWith('.jsonl'))
          .sort()
          .reverse()
        for (const file of files) {
          const info = await stat(join(dir, file))
          // 5s grace window for clock skew between spawn timestamp and file creation
          if (info.birthtimeMs < spawnedAt - 5000) break // files are sorted newest-first
          const match = file.match(
            /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
          )
          if (!match) continue

          // Verify cwd matches to disambiguate concurrent sessions.
          // Read only the first line (session_meta) — files can be multi-MB.
          let firstLine: string
          const fh = await open(join(dir, file), 'r')
          try {
            const buf = Buffer.alloc(4096)
            const { bytesRead } = await fh.read({ buffer: buf, length: 4096 })
            firstLine = buf.toString('utf-8', 0, bytesRead).split('\n', 1)[0]
          } finally {
            await fh.close()
          }

          try {
            const meta = JSON.parse(firstLine)
            // If we have CWD in metadata, it MUST match.
            // If metadata is missing CWD (unlikely for modern Codex), we allow it as a fallback.
            if (meta?.payload?.cwd) {
              if (meta.payload.cwd === cwd) return match[1]
              // CWD present but mismatch — skip this file
              continue
            }
          } catch {
            // Malformed first line — skip this file to be safe
            continue
          }

          // Fallback if metadata parse succeeded but cwd was missing
          return match[1]
        }
      } catch {
        // Directory doesn't exist or not readable
      }
    }
    return null
  }

  detectPrompt(data: string): PromptInfo | null {
    const stripped = CodexAdapter.normalizeText(CodexAdapter.stripAnsi(data))
    if (CodexAdapter.hasApprovalModal(stripped)) {
      return { type: 'permission', text: stripped, position: 0 }
    }
    return null
  }

  detectConversationId(data: string): string | null {
    const stripped = CodexAdapter.stripAnsi(data)
    // Try labeled match first (most specific)
    const labeled = stripped.match(
      /session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im
    )
    if (labeled) return labeled[1]
    // Rollout filename format
    const rollout = stripped.match(
      /rollout-[0-9]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    )
    if (rollout) return rollout[1]
    // Last resort: any UUID in the output (handles box-drawing chars, cursor artifacts)
    const bare = stripped.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    return bare ? bare[1] : null
  }
}
