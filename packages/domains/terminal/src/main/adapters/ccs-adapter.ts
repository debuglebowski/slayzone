import type { TerminalAdapter, PromptInfo, ActivityState, ErrorInfo, ValidationResult } from './types'
import { whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for CCS (Claude Code Switch).
 * CCS manages sessions internally — no --resume or --session-id.
 * Provider args (flags field) = profile name.
 */
export class CcsAdapter implements TerminalAdapter {
  readonly mode = 'ccs' as const
  readonly idleTimeoutMs = null // same as Claude (CCS runs Claude underneath)

  // CCS runs Claude Code underneath — reuse Claude's activity patterns
  detectActivity(data: string, _current: ActivityState): ActivityState | null {
    const stripped = data
      .replace(/\x1b\]([^\x07\x1b]|\x1b(?!\\))*(\x07|\x1b\\|\x9c)/g, '')
      .replace(/\x1b\[[?0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b[()][AB012]/g, '')
      .trimStart()

    if (/(?:^|\n|\r)❯\s*\d+\./.test(stripped)) return 'attention'
    if (/(?:^|\n|\r)❯[A-Za-z]/.test(stripped)) return 'attention'
    if (/\[Y\/n\]|\[y\/N\]/i.test(stripped)) return 'attention'
    if (/(?:^|\n|\r)❯\s/.test(stripped)) return 'attention'

    if (/^[·✻✽✶✳✢].*\bfor \d+[smh]/m.test(stripped)) return 'attention'
    if (/^[·✻✽✶✳✢]/m.test(stripped)) return 'working'

    return null
  }

  detectError(data: string): ErrorInfo | null {
    const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    const errorMatch = stripped.match(/^Error:\s*(.+)/im)
    if (errorMatch) {
      return { code: 'CLI_ERROR', message: errorMatch[1].trim(), recoverable: true }
    }
    return null
  }

  detectPrompt(data: string): PromptInfo | null {
    const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

    if (/\[Y\/n\]|\[y\/N\]/i.test(stripped)) {
      return { type: 'permission', text: data, position: 0 }
    }
    if (/(?:^|\n|\r)❯\s*\d+\./m.test(stripped)) {
      return { type: 'input', text: data, position: 0 }
    }
    const questionMatch = stripped.match(/[^\n]*\?\s*$/m)
    if (questionMatch) {
      return { type: 'question', text: questionMatch[0].trim(), position: data.indexOf(questionMatch[0]) }
    }
    return null
  }

  async validate(): Promise<ValidationResult[]> {
    const [shell, found] = await Promise.all([validateShellEnv(), whichBinary('ccs')])
    const results: ValidationResult[] = []
    if (!shell.ok) results.push(shell)
    results.push({
      check: 'Binary found',
      ok: !!found,
      detail: found ?? 'ccs not found in PATH',
      fix: found ? undefined : 'Install CCS: https://github.com/anthropics/ccs'
    })
    return results
  }
}
