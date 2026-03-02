import type { TerminalAdapter, SpawnResult, PromptInfo, CodeMode, ActivityState, ErrorInfo, ValidationResult } from './types'
import { buildExecCommand, getShellStartupArgs, resolveUserShell, whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for Claude Code CLI.
 * Uses pattern-based heuristics for activity detection in interactive mode.
 */
export class ClaudeAdapter implements TerminalAdapter {
  readonly mode = 'claude-code' as const
  readonly idleTimeoutMs = null // use default 60s

  buildSpawnConfig(_cwd: string, conversationId?: string, resuming?: boolean, initialPrompt?: string, providerArgs: string[] = [], codeMode?: CodeMode): SpawnResult {
    const claudeArgs: string[] = []

    // Pass --resume for existing sessions, --session-id for new ones
    if (resuming && conversationId) {
      claudeArgs.push('--resume', conversationId)
    } else if (conversationId) {
      claudeArgs.push('--session-id', conversationId)
    }

    // Add bypass flag if code mode requests full automation.
    if (codeMode === 'bypass') {
      claudeArgs.push('--allow-dangerously-skip-permissions')
    }

    claudeArgs.push(...providerArgs)

    // Handle accept-edits mode: allow edit tools without prompting
    if (codeMode === 'accept-edits') {
      claudeArgs.push('--allowedTools', 'Edit,Write,MultiEdit,NotebookEdit')
    }

    // Add initial prompt as positional argument (claude "prompt")
    // Note: Do NOT use -p flag, that's for non-interactive "print and exit" mode
    // Note: Plan mode prefix (/plan) is handled by injecting into terminal, not here
    if (initialPrompt) {
      claudeArgs.push(initialPrompt)
    }

    const shell = resolveUserShell()
    return {
      config: {
        shell,
        args: getShellStartupArgs(shell),
        postSpawnCommand: buildExecCommand('claude', claudeArgs),
      },
      binary: { name: 'claude', args: claudeArgs }
    }
  }

  detectActivity(data: string, _current: ActivityState): ActivityState | null {
    // Strip ANSI escape codes for pattern matching
    const stripped = data
      .replace(/\x1b\][^\x07]*\x07/g, '')  // OSC sequences
      .replace(/\x1b\[[?0-9;]*[A-Za-z]/g, '')  // CSI (including ?)
      .replace(/\x1b[()][AB012]/g, '')  // Character set
      .trimStart()  // Remove leading whitespace including \r (keep trailing for prompt detection)

    // 1. Attention: user needs to respond (menus, prompts, ready for input)
    // - Numbered menu: ❯ 1. or ❯1.
    // - Menu selection: ❯Option (no space after)
    // - Y/n prompts
    // - Prompt with space (ready for user input)
    if (/(?:^|\n|\r)❯\s*\d+\./.test(stripped)) return 'attention'
    if (/(?:^|\n|\r)❯[A-Za-z]/.test(stripped)) return 'attention'
    if (/\[Y\/n\]|\[y\/N\]/i.test(stripped)) return 'attention'
    if (/(?:^|\n|\r)❯\s/.test(stripped)) return 'attention'

    // 2. Working: spinner at start (but not "X for Ym Zs" completion summary)
    if (/^[·✻✽✶✳✢].*\bfor \d+[smh]/m.test(stripped)) return 'attention'
    if (/^[·✻✽✶✳✢]/m.test(stripped)) return 'working'

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
