/**
 * Who a chat talks to, for the chat UI's wording: "Ask Codex anything…",
 * "Claude is waiting for your answer", the project memory file `/memory` opens,
 * where `/bug` files an issue. The product name and a mode's provider come from
 * the existing tables (`DETECTION_ENGINES`, `DEFAULT_TERMINAL_MODES`); this adds
 * only what they don't carry.
 *
 * @module shared/chat-provider
 */
import { DEFAULT_TERMINAL_MODES, DETECTION_ENGINES } from './types'

export interface ChatProviderInfo {
  /** The provider's detection type (`DETECTION_ENGINES` / `TerminalModeInfo.type`). */
  type: string
  /** The CLI's product name: `Claude Code`, `Codex`. */
  product: string
  /** The agent as a sentence names it: "Ask Claude anything", "Codex is waiting". */
  agent: string
  /** The CLI binary (`AgentProblem.binary`). */
  binary: string
  /** The project instructions file the CLI reads. */
  memoryFile: string
  installUrl: string
  issuesUrl: string
  releasesUrl: string
}

type ProviderExtras = Omit<ChatProviderInfo, 'type' | 'product'>

/** Per chat-capable provider, keyed by detection type. */
const PROVIDERS: Record<string, ProviderExtras> = {
  'claude-code': {
    agent: 'Claude',
    binary: 'claude',
    memoryFile: 'CLAUDE.md',
    installUrl: 'https://claude.com/claude-code',
    issuesUrl: 'https://github.com/anthropics/claude-code/issues/new',
    releasesUrl: 'https://github.com/anthropics/claude-code/releases'
  },
  codex: {
    agent: 'Codex',
    binary: 'codex',
    memoryFile: 'AGENTS.md',
    installUrl: 'https://github.com/openai/codex',
    issuesUrl: 'https://github.com/openai/codex/issues/new',
    releasesUrl: 'https://github.com/openai/codex/releases'
  }
}

/** Chat's default provider: what an unknown mode is shown as. */
const DEFAULT_TYPE = 'claude-code'

function infoForType(type: string): ChatProviderInfo | null {
  const extras = PROVIDERS[type]
  if (!extras) return null
  const product = DETECTION_ENGINES.find((e) => e.type === type)?.label ?? extras.agent
  return { type, product, ...extras }
}

/** The provider of a terminal / chat mode (`claude-chat` → Claude Code, `codex-chat` → Codex). */
export function chatProviderForMode(mode: string): ChatProviderInfo {
  const type = DEFAULT_TERMINAL_MODES.find((m) => m.id === mode)?.type
  return (type ? infoForType(type) : null) ?? (infoForType(DEFAULT_TYPE) as ChatProviderInfo)
}

/** The provider whose CLI binary is `binary`, or null. */
export function chatProviderForBinary(binary: string): ChatProviderInfo | null {
  const type = Object.keys(PROVIDERS).find((t) => PROVIDERS[t].binary === binary)
  return type ? infoForType(type) : null
}
