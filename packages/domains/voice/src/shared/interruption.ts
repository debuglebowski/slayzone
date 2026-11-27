/**
 * Interruption tracking: which sentence of a spoken reply the user cut off.
 * Sentences are numbered per reply (1-based), in the order they were queued.
 */

export interface InterruptionPoint {
  /** The sentence that was playing; null when the cut came between sentences. */
  during: { index: number; text: string } | null
  /** Sentences fully heard before the cut. */
  heard: number
  /** Queued or still-streaming sentences that were never heard. */
  unheard: boolean
}

export class ReplyPlaybackTracker {
  private sentences: string[] = []
  private playing: number | null = null
  private heard = 0
  private streaming = false

  /** A new reply starts (numbering restarts). */
  begin(): void {
    this.sentences = []
    this.playing = null
    this.heard = 0
    this.streaming = true
  }

  /** The reply's text is complete (no more sentences will be queued). */
  complete(): void {
    this.streaming = false
  }

  /** Returns the sentence's 1-based index. */
  queued(text: string): number {
    this.sentences.push(text)
    return this.sentences.length
  }

  started(index: number): void {
    this.playing = index
  }

  finished(index: number): void {
    if (this.playing === index) this.playing = null
    this.heard = Math.max(this.heard, index)
  }

  /** Something of this reply is playing, queued, or still streaming in. */
  active(): boolean {
    return this.playing !== null || this.heard < this.sentences.length || this.streaming
  }

  /** The user cut in now. Null if nothing of the reply was left to hear. */
  interrupt(): InterruptionPoint | null {
    if (!this.active()) return null
    const during =
      this.playing !== null ? { index: this.playing, text: this.sentences[this.playing - 1] } : null
    const lastIndex = during ? during.index : this.heard
    const point: InterruptionPoint = {
      during,
      heard: this.heard,
      unheard: this.streaming || this.sentences.length > lastIndex
    }
    this.playing = null
    this.streaming = false
    this.sentences = []
    this.heard = 0
    return point
  }
}

/** The note prepended to the user's next turn so the agent knows what was not heard. */
export function formatInterruptionNote(point: InterruptionPoint): string {
  const later = point.unheard ? '; later sentences were not heard' : ''
  if (point.during) {
    const text = point.during.text.replace(/"/g, "'")
    return `[interrupted during sentence ${point.during.index}: "${text}"${later}]`
  }
  if (point.heard === 0) return '[interrupted before any of the reply was heard]'
  return `[interrupted after sentence ${point.heard}${later}]`
}
