import type { AiActionParams } from './types'

/**
 * Provider info needed to build a headless command. Sourced from the
 * `agents` row — engine looks it up by id.
 */
export interface ProviderInfo {
  id: string
  type: string
  headlessCommand?: string | null
  defaultFlags?: string | null
}

/**
 * Single-quote escape for POSIX shell. Wraps the value in single quotes and
 * escapes any embedded single quote by closing/escaping/reopening: a'b -> 'a'\''b'
 * Newlines + internal whitespace are preserved bytewise inside the quotes.
 */
export function shellSingleQuote(value: unknown): string {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value)
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Build the headless CLI command for an AI action by substituting `{prompt}`
 * + `{flags}` slots in the provider's stored template. Returns null if the
 * provider has no template (i.e. mode does not support headless invocation).
 *
 * Substitution semantics:
 * - `{prompt}` is replaced with a single-quote-escaped prompt. Multi-line +
 *   internally-spaced prompts are preserved bytewise.
 * - `{flags}` is replaced with raw flags (un-quoted, by design — flags are
 *   trusted user config). Empty/whitespace flags collapse the slot AND one
 *   adjacent space so the resulting command has no double-spaces.
 * - Only `undefined` falls back to provider defaults; explicit empty string
 *   means "no flags".
 */
export function buildAiHeadlessCommand(
  params: AiActionParams,
  provider: ProviderInfo
): string | null {
  const template = provider.headlessCommand?.trim()
  if (!template) return null

  const flags = (params.flags ?? provider.defaultFlags ?? '').trim()
  const promptToken = shellSingleQuote(params.prompt)

  // Substitute flags first (and collapse one adjacent space when empty so the
  // command has no doubles). Substitute prompt last so its quoted body is
  // never re-processed — multi-line prompts stay intact.
  let out = template
  if (flags) {
    out = out.includes(' {flags}')
      ? out.replace(' {flags}', ` ${flags}`)
      : out.includes('{flags} ')
        ? out.replace('{flags} ', `${flags} `)
        : out.replace('{flags}', flags)
  } else {
    out = out.includes(' {flags}')
      ? out.replace(' {flags}', '')
      : out.includes('{flags} ')
        ? out.replace('{flags} ', '')
        : out.replace('{flags}', '')
  }
  out = out.replace('{prompt}', promptToken)

  return out.trim()
}
