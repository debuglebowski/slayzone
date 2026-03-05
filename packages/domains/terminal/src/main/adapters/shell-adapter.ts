import type { TerminalAdapter, SpawnResult, PromptInfo, CodeMode, ActivityState, ErrorInfo } from './types'
import { getShellStartupArgs, resolveUserShell } from '../shell-env'
import { parseShellArgs } from './flag-parser'

/**
 * Adapter for raw terminal/shell.
 * Passthrough with no special parsing or prompt detection.
 */
export class ShellAdapter implements TerminalAdapter {
  readonly mode = 'terminal' as const
  readonly idleTimeoutMs = null // use default 60s

  constructor(
    private readonly command?: string | null,
    private readonly args?: string | null,
    private readonly patterns?: {
      attention?: string | null
      working?: string | null
      error?: string | null
    }
  ) {}

  buildSpawnConfig(_cwd: string, _conversationId?: string, _resuming?: boolean, _initialPrompt?: string, _providerArgs?: string[], _codeMode?: CodeMode): SpawnResult {
    if (this.command) {
      const commandParts = parseShellArgs(this.command)
      const name = commandParts[0] || ''
      const commandArgs = commandParts.slice(1)

      const allArgs: string[] = [...commandArgs]
      if (this.args) {
        allArgs.push(...parseShellArgs(this.args))
      }

      return {
        config: {
          shell: resolveUserShell(),
          args: getShellStartupArgs(resolveUserShell())
        },
        binary: {
          name,
          args: allArgs,
          providerArgs: _providerArgs ?? []
        }
      }
    }

    const shell = resolveUserShell()
    return {
      config: {
        shell,
        args: getShellStartupArgs(shell)
      }
    }
  }

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][AB012]/g, '')
  }

  private static safeRegexTest(pattern: string | null | undefined, text: string): boolean {
    if (!pattern) return false
    try {
      return new RegExp(pattern, 'm').test(text)
    } catch (err) {
      console.error(`[ShellAdapter] Invalid regex pattern "${pattern}":`, err)
      return false
    }
  }

  detectActivity(data: string, _current: ActivityState): ActivityState | null {
    if (!this.patterns) return null
    const stripped = ShellAdapter.stripAnsi(data)

    if (ShellAdapter.safeRegexTest(this.patterns.attention, stripped)) {
      return 'attention'
    }

    if (ShellAdapter.safeRegexTest(this.patterns.working, stripped)) {
      return 'working'
    }

    return null
  }

  detectError(data: string): ErrorInfo | null {
    if (!this.patterns?.error) return null
    const stripped = ShellAdapter.stripAnsi(data)

    if (ShellAdapter.safeRegexTest(this.patterns.error, stripped)) {
      return {
        code: 'CUSTOM_ERROR',
        message: 'Error detected by pattern',
        recoverable: true
      }
    }

    return null
  }

  detectPrompt(data: string): PromptInfo | null {
    if (!this.patterns?.attention) return null
    const stripped = ShellAdapter.stripAnsi(data)

    if (ShellAdapter.safeRegexTest(this.patterns.attention, stripped)) {
      return {
        type: 'input',
        text: data,
        position: data.length
      }
    }

    return null
  }
}
