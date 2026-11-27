/**
 * The "no speak" token: an assistant message that STARTS with it is shown but
 * not spoken (the agent's choice — e.g. a long diff summary). Tolerant of the
 * spellings a model drifts to: `[no-speak]`, `[no speak]`, `[nospeak]`,
 * `<no-speak>`, any case.
 */
export const NO_SPEAK_TOKEN = '[no-speak]'

const FULL = /^\s*[[<(]\s*no[\s_-]?speak\s*[\]>)]/i
/** Text that could still become the token once more arrives. */
const PREFIX = /^\s*(?:[[<(]\s*(?:n(?:o(?:[\s_-]?(?:s(?:p(?:e(?:a(?:k\s*)?)?)?)?)?)?)?)?)?$/i

export type NoSpeakVerdict = 'undecided' | 'speak' | 'silent'

/**
 * Per assistant message: holds the first characters back until it is clear
 * whether the message opens with the token, then passes text through (speak)
 * or swallows all of it (silent).
 */
export class NoSpeakGate {
  private verdict: NoSpeakVerdict = 'undecided'
  private held = ''

  get state(): NoSpeakVerdict {
    return this.verdict
  }

  /** The part of `delta` to speak ('' while undecided or silent). */
  push(delta: string): string {
    if (this.verdict === 'silent') return ''
    if (this.verdict === 'speak') return delta
    this.held += delta
    if (FULL.test(this.held)) {
      this.verdict = 'silent'
      this.held = ''
      return ''
    }
    if (PREFIX.test(this.held)) return ''
    this.verdict = 'speak'
    const out = this.held
    this.held = ''
    return out
  }

  /** The message ended: anything still held (a short message like "No.") is spoken. */
  end(): string {
    if (this.verdict !== 'undecided') return ''
    this.verdict = 'speak'
    const out = this.held
    this.held = ''
    return out
  }
}
