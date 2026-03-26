import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TerminalAdapter, PromptInfo, ActivityState, ErrorInfo, ValidationResult } from './types'
import { whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for OpenAI Codex.
 * Codex uses a full-screen Ratatui TUI. State detection is binary:
 * working (shows interrupt/cancel hints) vs attention (idle timeout fallback).
 */
export class CodexAdapter implements TerminalAdapter {
  readonly mode = 'codex' as const
  // Codex TUI updates in many small chunks, so we keep "working" latched and
  // let a short idle timeout decide when activity has stopped.
  readonly idleTimeoutMs = 2500
  readonly sessionIdCommand = '/status'

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '')            // CSI sequences
      .replace(/\x1b[()][AB012]/g, '')            // Character set
  }

  private static normalizeText(data: string): string {
    return data.replace(/\s+/g, ' ').trim()
  }

  private static hasWorkingIndicator(text: string): boolean {
    return /\b(?:esc|escape)\s+to\s+(?:interrupt|cancel|stop)\b/i.test(text)
      || /\b(?:ctrl\s*\+\s*c|control-c)\s+to\s+(?:interrupt|cancel|stop)\b/i.test(text)
  }

  detectActivity(data: string, current: ActivityState): ActivityState | null {
    const stripped = CodexAdapter.normalizeText(CodexAdapter.stripAnsi(data))

    // Codex shows an interrupt hint while the agent is actively working.
    // This can arrive fragmented across many redraw chunks, so when we are
    // already in "working", don't force "attention" on non-matching chunks.
    if (CodexAdapter.hasWorkingIndicator(stripped)) return 'working'

    if (current === 'working') return null

    return null
  }

  detectError(_data: string): ErrorInfo | null {
    const stripped = CodexAdapter.stripAnsi(_data)

    // Codex resume session not found variants.
    if (
      /no saved session found with id/i.test(stripped)
      || /no conversation found with (?:session )?id/i.test(stripped)
      || /session \S+ not found/i.test(stripped)
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
    const [shell, node, codex] = await Promise.all([validateShellEnv(), whichBinary('node'), whichBinary('codex')])
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
  async detectSessionFromDisk(spawnedAt: number, cwd: string): Promise<string | null> {
    const now = new Date()
    const dir = join(
      homedir(), '.codex', 'sessions',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    )

    try {
      const files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort().reverse()
      for (const file of files) {
        const info = await stat(join(dir, file))
        // 5s grace window for clock skew between spawn timestamp and file creation
        if (info.birthtimeMs < spawnedAt - 5000) break // files are sorted newest-first
        const match = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
        if (!match) continue
        // Verify cwd matches to disambiguate concurrent sessions.
        // Read only the first line (session_meta) — files can be multi-MB.
        let firstLine: string
        const fh = await open(join(dir, file), 'r')
        try {
          firstLine = (await fh.read({ buffer: Buffer.alloc(4096), length: 4096 })).buffer.toString('utf-8').split('\n', 1)[0]
        } finally {
          await fh.close()
        }
        try {
          const meta = JSON.parse(firstLine)
          if (meta?.payload?.cwd && meta.payload.cwd !== cwd) continue
        } catch {
          // Malformed first line — skip cwd check, still usable
        }
        return match[1]
      }
    } catch {
      // Directory doesn't exist or not readable
    }
    return null
  }

  detectPrompt(_data: string): PromptInfo | null {
    // TODO: Implement when Codex output format is known
    return null
  }
}
