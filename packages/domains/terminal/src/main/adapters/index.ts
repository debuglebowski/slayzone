export type {
  TerminalMode,
  TerminalAdapter,
  SpawnShellConfig,
  SpawnConfig,
  SpawnResult,
  SpawnBinaryInfo,
  PromptInfo,
  ActivityState,
  ErrorInfo,
  CLIState,
  ExecutionContext
} from './types'

import type { TerminalAdapter } from './types'
import { CcsAdapter } from './ccs-adapter'
import { ClaudeAdapter } from './claude-adapter'
import { CodexAdapter } from './codex-adapter'
import { CursorAdapter } from './cursor-adapter'
import { GeminiAdapter } from './gemini-adapter'
import { AntigravityAdapter } from './antigravity-adapter'
import { OpencodeAdapter } from './opencode-adapter'
import { QwenAdapter } from './qwen-adapter'
import { CopilotAdapter } from './copilot-adapter'
import { ShellAdapter } from './shell-adapter'

const BUILTIN_ADAPTERS: Record<string, new () => TerminalAdapter> = {
  ccs: CcsAdapter,
  'claude-code': ClaudeAdapter,
  codex: CodexAdapter,
  'cursor-agent': CursorAdapter,
  gemini: GeminiAdapter,
  antigravity: AntigravityAdapter,
  opencode: OpencodeAdapter,
  'qwen-code': QwenAdapter,
  copilot: CopilotAdapter,
  terminal: ShellAdapter
}

/**
 * Modes whose running/idle state is fully hook-driven — the SINGLE source of
 * truth, derived once from each adapter's `hookDriven` flag. Consumed by the
 * input-flip gate (`shouldFlipToRunningOnInput`, which skips the optimistic
 * Enter→running flip for these) AND the agent-hook route (which drives state
 * from lifecycle hooks for these). Both read from here, so they cannot drift:
 * making a provider hook-driven = set `hookDriven = true` on its adapter.
 */
export const HOOK_DRIVEN_MODES: ReadonlySet<string> = new Set(
  Object.entries(BUILTIN_ADAPTERS)
    .filter(([, AdapterClass]) => new AdapterClass().hookDriven === true)
    .map(([mode]) => mode)
)

/** True when a terminal mode's state is fully hook-driven (see `HOOK_DRIVEN_MODES`). */
export function isHookDrivenMode(mode: string): boolean {
  return HOOK_DRIVEN_MODES.has(mode)
}

export interface GetAdapterOptions {
  mode: string
  type?: string
  patterns?: {
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
