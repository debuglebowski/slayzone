/**
 * Claude model the chat subprocess targets. Stored in
 * `provider_config.<terminalMode>.chatModel`.
 *
 * Mirrors the `claude --model` CLI accepted aliases. Full Anthropic ids
 * (`claude-sonnet-4-5-...`) also work but the alias keeps task DB stable
 * across model rev-bumps.
 *
 * No `'default'` option — the UI surfaces only concrete picks. When nothing
 * is stored, callers fall back to the account default resolved from
 * `~/.claude/settings.json` (see `account-default-model.ts`); ultimate
 * fallback is `DEFAULT_CHAT_MODEL`.
 */
export type ChatModel = 'opus' | 'sonnet' | 'haiku'

/** Order matches the dropdown UI. */
export const CHAT_MODELS: ChatModel[] = ['opus', 'sonnet', 'haiku']

/** Hard fallback when neither DB nor `~/.claude/settings.json` resolves. */
export const DEFAULT_CHAT_MODEL: ChatModel = 'opus'

/** CLI flags for a given model id. Always `--model <id>`. */
export function chatModelToFlags(model: string): string[] {
  return ['--model', model]
}

export function isChatModel(v: unknown): v is ChatModel {
  return typeof v === 'string' && (CHAT_MODELS as string[]).includes(v)
}

/**
 * Map a raw `model` string from `~/.claude/settings.json` (or a legacy
 * stored value like `'default'`) to one of our concrete aliases. Accepts
 * shortform aliases (`opus`, `sonnet`, `haiku`) and full ids
 * (`claude-opus-4-7`, `claude-3-5-sonnet-20241022`).
 * Returns `DEFAULT_CHAT_MODEL` for unknown / null / unparseable.
 */
export function normalizeAccountModel(raw: string | null | undefined): ChatModel {
  if (!raw || typeof raw !== 'string') return DEFAULT_CHAT_MODEL
  const s = raw.toLowerCase()
  if (s.includes('opus')) return 'opus'
  if (s.includes('sonnet')) return 'sonnet'
  if (s.includes('haiku')) return 'haiku'
  return DEFAULT_CHAT_MODEL
}
