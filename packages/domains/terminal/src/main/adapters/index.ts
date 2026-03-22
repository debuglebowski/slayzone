export type { TerminalMode, TerminalAdapter, SpawnShellConfig, SpawnConfig, SpawnResult, SpawnBinaryInfo, PromptInfo, ActivityState, ErrorInfo, CLIState, ExecutionContext } from './types'

import type { TerminalAdapter } from './types'
import { CcsAdapter } from './ccs-adapter'
import { ClaudeAdapter } from './claude-adapter'
import { CodexAdapter } from './codex-adapter'
import { CursorAdapter } from './cursor-adapter'
import { GeminiAdapter } from './gemini-adapter'
import { OpencodeAdapter } from './opencode-adapter'
import { QwenAdapter } from './qwen-adapter'
import { CopilotAdapter } from './copilot-adapter'
import { ShellAdapter } from './shell-adapter'

const BUILTIN_ADAPTERS: Record<string, new () => TerminalAdapter> = {
  'ccs': CcsAdapter,
  'claude-code': ClaudeAdapter,
  'codex': CodexAdapter,
  'cursor-agent': CursorAdapter,
  'gemini': GeminiAdapter,
  'opencode': OpencodeAdapter,
  'qwen-code': QwenAdapter,
  'copilot': CopilotAdapter,
  'terminal': ShellAdapter
}

export interface GetAdapterOptions {
  mode: string
  type?: string
  patterns?: {
    attention?: string | null
    working?: string | null
    error?: string | null
  }
}

/**
 * Get the adapter for a terminal mode.
 */
export function getAdapter(opts: GetAdapterOptions): TerminalAdapter {
  const adapterType = opts.type || opts.mode
  const AdapterClass = BUILTIN_ADAPTERS[adapterType]

  // If it's a specialized AI adapter type (and not the generic 'terminal' type), use it
  if (AdapterClass && adapterType !== 'terminal') {
    return new AdapterClass()
  }

  // Use ShellAdapter for raw 'terminal' mode OR custom modes (which have type='terminal' + a custom template)
  return new ShellAdapter(opts.patterns)
}

/**
 * Get the default adapter (claude-code).
 */
export function getDefaultAdapter(): TerminalAdapter {
  return new ClaudeAdapter()
}
