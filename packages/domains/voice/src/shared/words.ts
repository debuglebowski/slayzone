/** Word-level helpers for keyword matching: case- and punctuation-insensitive. */

/** Lowercase, letters/digits/apostrophes only ("Over." → "over", "that's" stays). */
export function normalizeWord(token: string): string {
  return token
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .replace(/^'+|'+$/g, '')
}

/** The normalized words of a phrase ("Scratch that!" → ["scratch", "that"]). */
export function phraseWords(phrase: string): string[] {
  return phrase
    .split(/\s+/)
    .map(normalizeWord)
    .filter((w) => w.length > 0)
}

/**
 * If `text` ends with `phrase` (whole words, ignoring case and punctuation),
 * the text without it — trailing punctuation and separators trimmed. Null when
 * it does not end with the phrase.
 */
export function stripTrailingPhrase(text: string, phrase: string): string | null {
  const target = phraseWords(phrase)
  if (target.length === 0) return null
  // Whitespace only: a hyphenated word ("take-over") is one word, never the keyword.
  const tokens = text.split(/(\s+)/)
  let ti = target.length - 1
  let cut = tokens.length
  for (let i = tokens.length - 1; i >= 0 && ti >= 0; i--) {
    const word = normalizeWord(tokens[i])
    if (word.length === 0) continue
    if (word !== target[ti]) return null
    ti--
    cut = i
  }
  if (ti >= 0) return null
  return tokens
    .slice(0, cut)
    .join('')
    .replace(/[\s,;:\-–—]+$/u, '')
    .trim()
}
