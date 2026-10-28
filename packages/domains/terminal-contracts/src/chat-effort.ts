import type { ChatModel } from './chat-model'

/**
 * Reasoning effort level for the chat subprocess. `null` = inherit provider
 * default (no `--effort` flag emitted). Stored in
 * `provider_config.<terminalMode>.chatEffort`.
 *
 * Mirrors `claude --effort` accepted values. Pill is gated by
 * `modelSupportsEffort` — haiku has no extended thinking and the flag is hidden.
 */
export type ChatEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const CHAT_EFFORTS: ChatEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Display fallback when nothing has been persisted yet. Pill always shows a concrete level. */
export const DEFAULT_CHAT_EFFORT: ChatEffort = 'medium'

/** CLI flags for a given ChatEffort. `null` emits none → CLI/account default. */
export function chatEffortToFlags(effort: ChatEffort | null | undefined): string[] {
  return effort ? ['--effort', effort] : []
}

export function isChatEffort(v: unknown): v is ChatEffort {
  return typeof v === 'string' && (CHAT_EFFORTS as string[]).includes(v)
}

/**
 * Whether a model supports reasoning effort. Haiku is fast/cheap and
 * doesn't expose an effort lever; everything else (including `default`,
 * which inherits the account default — usually sonnet/opus) does.
 */
export function modelSupportsEffort(model: ChatModel): boolean {
  return model !== 'haiku'
}
