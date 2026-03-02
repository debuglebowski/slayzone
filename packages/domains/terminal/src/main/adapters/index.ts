export type { TerminalMode, TerminalAdapter, SpawnConfig, SpawnResult, SpawnBinaryInfo, PromptInfo, ActivityState, ErrorInfo, CLIState, ExecutionContext } from './types'

import type { TerminalMode, TerminalAdapter } from './types'
import { ClaudeAdapter } from './claude-adapter'
import { CodexAdapter } from './codex-adapter'
import { CursorAdapter } from './cursor-adapter'
import { GeminiAdapter } from './gemini-adapter'
import { OpencodeAdapter } from './opencode-adapter'
import { ShellAdapter } from './shell-adapter'

const adapters: Record<TerminalMode, TerminalAdapter> = {
  'claude-code': new ClaudeAdapter(),
  'codex': new CodexAdapter(),
  'cursor-agent': new CursorAdapter(),
  'gemini': new GeminiAdapter(),
  'opencode': new OpencodeAdapter(),
  'terminal': new ShellAdapter()
}

/**
 * Get the adapter for a terminal mode.
 */
export function getAdapter(mode: TerminalMode): TerminalAdapter {
  return adapters[mode]
}

/**
 * Get the default adapter (claude-code).
 */
export function getDefaultAdapter(): TerminalAdapter {
  return adapters['claude-code']
}
