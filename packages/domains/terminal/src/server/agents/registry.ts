import type { AgentBackend } from './types'
import { claudeChatBackend } from './claude-session-driver'
import { codexChatBackend } from './codex/codex-chat-session'
import { CHAT_SUPPORTED_MODES, type ChatSupportedMode } from '../../shared/types'

/**
 * TerminalMode → AgentBackend mapping. Keys must match `CHAT_SUPPORTED_MODES`
 * exactly — TS enforces it, and the boot-time loop below fails fast on drift.
 * `'claude-code'`/`'codex'` are intentionally absent: those are PTY-only
 * modes; chat lives in `'claude-chat'` / `'codex-chat'`.
 */
const REGISTRY: Record<ChatSupportedMode, AgentBackend> = {
  'claude-chat': claudeChatBackend,
  'codex-chat': codexChatBackend
}

// Defense-in-depth: catch drift between CHAT_SUPPORTED_MODES and REGISTRY at boot.
for (const mode of CHAT_SUPPORTED_MODES) {
  if (!REGISTRY[mode]) throw new Error(`Missing agent backend for chat-capable mode '${mode}'`)
}

export function getBackend(mode: string): AgentBackend | null {
  return (REGISTRY as Record<string, AgentBackend>)[mode] ?? null
}

export function supportsChatMode(mode: string): boolean {
  return mode in REGISTRY
}
