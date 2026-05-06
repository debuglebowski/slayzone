import type { AgentAdapter } from './types'
import { claudeCodeAdapter } from './claude-code-adapter'

/**
 * TerminalMode → AgentAdapter mapping.
 * v1: only claude-code. Add adapters here as providers are ported.
 */
const REGISTRY: Record<string, AgentAdapter> = {
  'claude-code': claudeCodeAdapter,
}

export function getAdapter(mode: string): AgentAdapter | null {
  return REGISTRY[mode] ?? null
}

export function supportsChatMode(mode: string): boolean {
  return mode in REGISTRY
}
