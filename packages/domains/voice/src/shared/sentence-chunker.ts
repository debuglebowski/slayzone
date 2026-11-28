/**
 * Splits a streamed reply into speakable sentences as the text arrives, so the
 * first sentence goes to TTS while the rest is still streaming.
 *
 * A sentence ends at `.`/`!`/`?`/`…` followed by whitespace (so "index.ts" and
 * "3.5" never split), at a line break, or — for a run-on with no terminator — at
 * a clause break once it is long. Fenced code blocks are dropped (not
 * speakable); inline markdown is stripped from each sentence.
 */

const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'no',
  'approx',
  'cf'
])

/** A run-on sentence is cut at a clause break once it is this long. */
const MAX_SENTENCE_CHARS = 220

export class SentenceChunker {
  private buf = ''
  private inFence = false

  /** Feed a streamed text delta; returns the sentences it completed. */
  push(delta: string): string[] {
    this.buf += delta
    return this.drain(false)
  }

  /** End of the text: returns what is left as a final sentence (if speakable). */
  flush(): string[] {
    const out = this.drain(true)
    this.buf = ''
    this.inFence = false
    return out
  }

  reset(): void {
    this.buf = ''
    this.inFence = false
  }

  private drain(final: boolean): string[] {
    const out: string[] = []
    for (;;) {
      if (this.inFence) {
        const close = this.buf.indexOf('```')
        if (close < 0) {
          if (final) this.buf = ''
          return out
        }
        const eol = this.buf.indexOf('\n', close + 3)
        if (eol < 0 && !final) return out
        this.buf = eol < 0 ? '' : this.buf.slice(eol + 1)
        this.inFence = false
        continue
      }
      const fence = this.buf.indexOf('```')
      const cut = findBoundary(this.buf, fence < 0 ? this.buf.length : fence, final)
      if (cut !== null) {
        push(out, this.buf.slice(0, cut))
        this.buf = this.buf.slice(cut)
        continue
      }
      if (fence >= 0) {
        push(out, this.buf.slice(0, fence))
        this.buf = this.buf.slice(fence + 3)
        this.inFence = true
        continue
      }
      if (final) {
        push(out, this.buf)
        this.buf = ''
      }
      return out
    }
  }
}

function push(out: string[], raw: string): void {
  const s = speakable(raw)
  if (s) out.push(s)
}

/** End index (exclusive) of the first complete sentence in `text[0, limit)`, or null. */
function findBoundary(text: string, limit: number, final: boolean): number | null {
  for (let i = 0; i < limit; i++) {
    const c = text[i]
    if (c === '\n') return i + 1
    if (c === '.' || c === '!' || c === '?' || c === '…') {
      let j = i + 1
      while (j < text.length && /[.!?…"'’”)\]]/.test(text[j])) j++
      if (j >= text.length) {
        // Need the next character to know (unless the text is complete).
        if (final && j <= limit) return j
        return null
      }
      if (j > limit) return null
      if (!/\s/.test(text[j])) {
        i = j - 1
        continue
      }
      if (c === '.' && isAbbreviation(text, i)) {
        i = j - 1
        continue
      }
      return j
    }
  }
  if (limit >= MAX_SENTENCE_CHARS) {
    const head = text.slice(0, Math.min(limit, MAX_SENTENCE_CHARS))
    const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '))
    if (clause > MAX_SENTENCE_CHARS / 3) return clause + 1
    const space = head.lastIndexOf(' ')
    if (space > 0) return space
  }
  return null
}

function isAbbreviation(text: string, dot: number): boolean {
  let s = dot
  while (s > 0 && /[A-Za-z.]/.test(text[s - 1])) s--
  const word = text.slice(s, dot).toLowerCase()
  if (ABBREVIATIONS.has(word)) return true
  // A single capital letter (an initial: "J. Smith").
  return /^[a-z]$/.test(word) && /[A-Z]/.test(text[dot - 1])
}

/** Strip markdown that should not be read aloud. Empty when nothing speakable is left. */
export function speakable(raw: string): string {
  let s = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|[.,!?;:]|$)/g, '$1$2')
  s = s
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
        .replace(/^\s*\|.*\|\s*$/, '')
        .replace(/^\s*[-=*_]{3,}\s*$/, '')
    )
    .join(' ')
  s = s.replace(/\s+/g, ' ').trim()
  return /[\p{L}\p{N}]/u.test(s) ? s : ''
}
