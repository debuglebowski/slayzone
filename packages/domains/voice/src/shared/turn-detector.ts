import { hasWords, stripTrailingPhrase } from './words'

export interface TurnDetectorConfig {
  /** Spoken as the last word(s) of an utterance, it ends the turn (radio "over"). */
  endKeyword: string
  /** Spoken as the last words, it throws the turn's buffer away. */
  discardKeyword: string
  /** Silence after the keyword before it counts (a word mid-sentence does not). */
  keywordSilenceMs: number
  /** Forgotten keyword: after this much silence, play a tone… */
  fallbackToneMs: number
  /** …and if it stays silent this long after the tone, end the turn anyway. */
  fallbackEndMs: number
}

export const DEFAULT_TURN_DETECTOR_CONFIG: TurnDetectorConfig = {
  endKeyword: 'over',
  discardKeyword: 'scratch that',
  keywordSilenceMs: 300,
  fallbackToneMs: 8000,
  fallbackEndMs: 2000
}

export type TurnDecision =
  | { kind: 'none' }
  /** Forgotten keyword: prompt the user with a short tone. */
  | { kind: 'tone' }
  | { kind: 'discard' }
  | {
      kind: 'end'
      /** The turn's text, keyword stripped. Never empty. */
      text: string
      reason: 'keyword' | 'timeout'
      /** When the last speech of the turn ended (the keyword's end, for `keyword`). */
      speechEndedAt: number
      /** When its transcript was ready. */
      transcribedAt: number
    }

/**
 * The turn buffer: transcripts of speech segments accumulate until the end
 * keyword is the buffer's final word AND at least `keywordSilenceMs` of silence
 * followed it. A long pause mid-thought therefore never ends the turn — only the
 * keyword does, or the tone-then-timeout fallback.
 *
 * Pure and clock-free: the caller passes times (ms) in, and polls `tick` (any
 * cadence ≤ ~50 ms keeps the keyword latency tight).
 */
export class TurnDetector {
  private segments: string[] = []
  private speaking = false
  /** Segments whose speech ended but whose transcript is not back yet. */
  private pending = 0
  private lastSpeechEndAt: number | null = null
  private lastTranscriptAt = 0
  private toneAt: number | null = null

  constructor(private config: TurnDetectorConfig = DEFAULT_TURN_DETECTOR_CONFIG) {}

  configure(config: TurnDetectorConfig): void {
    this.config = config
  }

  speechStarted(): void {
    this.speaking = true
    // Talking again answers the tone.
    this.toneAt = null
  }

  speechEnded(at: number): void {
    this.speaking = false
    this.pending++
    this.lastSpeechEndAt = at
  }

  /** A segment's transcript (in segment order). */
  transcript(text: string, at: number): void {
    if (this.pending > 0) this.pending--
    this.lastTranscriptAt = at
    const t = text.trim()
    // A cough, breath or "hmm" is not part of the turn (it would also start the
    // forgotten-keyword timeout and get sent on its own).
    if (hasWords(t)) this.segments.push(t)
  }

  /** The user is in the middle of a turn: speaking, being transcribed, or has unsent words. */
  isMidTurn(): boolean {
    return this.speaking || this.pending > 0 || this.segments.length > 0
  }

  text(): string {
    return this.segments.join(' ')
  }

  clear(): void {
    this.segments = []
    this.toneAt = null
  }

  tick(now: number): TurnDecision {
    if (this.speaking || this.pending > 0) return { kind: 'none' }
    if (this.segments.length === 0) {
      this.toneAt = null
      return { kind: 'none' }
    }
    const endedAt = this.lastSpeechEndAt ?? now
    const silence = now - endedAt
    if (silence >= this.config.keywordSilenceMs) {
      const text = this.text()
      if (stripTrailingPhrase(text, this.config.discardKeyword) !== null) {
        this.clear()
        return { kind: 'discard' }
      }
      const stripped = stripTrailingPhrase(text, this.config.endKeyword)
      if (stripped !== null) {
        this.clear()
        // Only the keyword: nothing to send.
        if (!stripped) return { kind: 'none' }
        return {
          kind: 'end',
          text: stripped,
          reason: 'keyword',
          speechEndedAt: endedAt,
          transcribedAt: this.lastTranscriptAt
        }
      }
    }
    if (this.toneAt === null) {
      if (silence >= this.config.fallbackToneMs) {
        this.toneAt = now
        return { kind: 'tone' }
      }
      return { kind: 'none' }
    }
    if (now - this.toneAt >= this.config.fallbackEndMs) {
      const text = this.text()
      this.clear()
      return {
        kind: 'end',
        text,
        reason: 'timeout',
        speechEndedAt: endedAt,
        transcribedAt: this.lastTranscriptAt
      }
    }
    return { kind: 'none' }
  }
}
