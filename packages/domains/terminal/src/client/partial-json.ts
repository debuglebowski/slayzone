/**
 * A streaming tool call's input as far as it arrived (plan 3.2): the CLI sends
 * the input as JSON text in pieces (`input_json_delta`). This closes what is
 * open — a value string is kept up to the last whole character, a key, a
 * dangling `:` / `,` or a cut literal is dropped (never guessed) — so a card can
 * show the command or file as it grows.
 *
 * @module terminal/client/partial-json
 */

const LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/

/** The parsed prefix of `text`, or undefined when nothing usable arrived yet. */
export function parsePartialJson(text: string): unknown {
  const s = text.trim()
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    // Incomplete — repair below.
  }
  const repaired = repair(s)
  if (repaired === null) return undefined
  try {
    return JSON.parse(repaired)
  } catch {
    return undefined
  }
}

/** `s` cut to its longest closable prefix, with the open containers closed. */
function repair(s: string): string | null {
  const stack: Array<'{' | '['> = []
  /** Per open container: the next string is an object key. */
  const expectKey: boolean[] = []
  let inString = false
  let isKey = false
  /** Index of a `\` whose escape is not complete yet, or -1. */
  let escapeAt = -1
  let unicodeLeft = 0
  /** Longest prefix that closes into valid JSON, and the containers open there. */
  let cut = -1
  let cutStack: Array<'{' | '['> = []
  const mark = (len: number): void => {
    cut = len
    cutStack = stack.slice()
  }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (unicodeLeft > 0) {
        unicodeLeft--
        if (unicodeLeft === 0) escapeAt = -1
      } else if (escapeAt >= 0) {
        if (c === 'u') unicodeLeft = 4
        else escapeAt = -1
      } else if (c === '\\') {
        escapeAt = i
      } else if (c === '"') {
        inString = false
        if (!isKey) mark(i + 1)
      }
      continue
    }
    const top = stack.length - 1
    if (c === '"') {
      inString = true
      isKey = stack[top] === '{' && expectKey[top] === true
    } else if (c === '{' || c === '[') {
      stack.push(c)
      expectKey.push(c === '{')
      mark(i + 1)
    } else if (c === '}' || c === ']') {
      stack.pop()
      expectKey.pop()
      mark(i + 1)
    } else if (c === ':') {
      if (top >= 0) expectKey[top] = false
    } else if (c === ',') {
      if (top >= 0 && stack[top] === '{') expectKey[top] = true
    } else if (!/\s/.test(c)) {
      // A number or literal: whole only if it is one (a cut one is dropped).
      let j = i
      while (j < s.length && !/[,\]}\s]/.test(s[j])) j++
      if (LITERAL.test(s.slice(i, j))) mark(j)
      i = j - 1
    }
  }

  let out: string
  let open: Array<'{' | '['>
  if (inString && !isKey) {
    // A value string still arriving: keep it up to its last whole character.
    out = `${s.slice(0, escapeAt >= 0 ? escapeAt : s.length)}"`
    open = stack
  } else {
    if (cut < 0) return null
    out = s.slice(0, cut)
    open = cutStack
  }
  for (let k = open.length - 1; k >= 0; k--) out += open[k] === '{' ? '}' : ']'
  return out
}
