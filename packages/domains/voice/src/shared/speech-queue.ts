import { isAbortError, type PcmAudio, type TtsProvider } from './providers'

/** Where synthesized speech is played (desktop: Web Audio; phone: native). */
export interface AudioSink {
  /**
   * Play `audio`. `onStart` fires when it is actually audible. Resolves true when
   * it played to the end, false when `stop()` cut it.
   */
  play(audio: PcmAudio, onStart: () => void): Promise<boolean>
  /** Stop whatever is playing (its `play` resolves false). */
  stop(): void
  /** The short "still there?" tone of the forgotten-keyword fallback. */
  tone(): void
}

export interface SpeechItem {
  text: string
  /** 1-based index of the sentence in its reply. */
  index: number
}

export interface SpeechQueueEvents {
  started(item: SpeechItem, at: number): void
  finished(item: SpeechItem): void
  synthesized?(item: SpeechItem, ms: number): void
  error?(item: SpeechItem, err: unknown): void
}

interface Entry extends SpeechItem {
  audio?: PcmAudio
  failed?: boolean
}

/** Sentences synthesized ahead of playback (TTS is faster than real time). */
const LOOKAHEAD = 2

/**
 * Sentences in, audio out, in order: TTS of the next sentences overlaps playback
 * of the current one. `stop()` drops everything — playing, queued and in-flight
 * synthesis — at once (barge-in).
 */
export class SpeechQueue {
  private entries: Entry[] = []
  private playing: Entry | null = null
  private synthesizing = false
  private abort = new AbortController()
  /** Bumped by `stop()`: late completions of the old generation are ignored. */
  private gen = 0

  constructor(
    private readonly tts: TtsProvider,
    private readonly sink: AudioSink,
    private readonly events: SpeechQueueEvents,
    private readonly now: () => number
  ) {}

  /** Playing, or sentences waiting to be synthesized / played. */
  busy(): boolean {
    return this.playing !== null || this.entries.length > 0
  }

  enqueue(item: SpeechItem): void {
    this.entries.push({ ...item })
    this.pump()
  }

  stop(): void {
    this.gen++
    this.abort.abort()
    this.abort = new AbortController()
    this.entries = []
    this.synthesizing = false
    if (this.playing) {
      this.playing = null
      this.sink.stop()
    }
  }

  private pump(): void {
    this.pumpSynth()
    this.pumpPlay()
  }

  private pumpSynth(): void {
    if (this.synthesizing) return
    const ready = this.entries.filter((e) => e.audio).length
    if (ready >= LOOKAHEAD) return
    const next = this.entries.find((e) => !e.audio && !e.failed)
    if (!next) return
    this.synthesizing = true
    const gen = this.gen
    const startedAt = this.now()
    this.tts
      .synthesize(next.text, this.abort.signal)
      .then(
        (audio) => {
          if (gen !== this.gen) return
          next.audio = audio
          this.events.synthesized?.(next, this.now() - startedAt)
        },
        (err: unknown) => {
          if (gen !== this.gen || isAbortError(err)) return
          next.failed = true
          this.events.error?.(next, err)
        }
      )
      .then(() => {
        if (gen !== this.gen) return
        this.synthesizing = false
        this.pump()
      })
  }

  private pumpPlay(): void {
    if (this.playing) return
    const head = this.entries[0]
    if (!head) return
    if (head.failed) {
      this.entries.shift()
      this.events.finished(head)
      this.pump()
      return
    }
    if (!head.audio) return
    this.entries.shift()
    this.playing = head
    const gen = this.gen
    this.sink
      .play(head.audio, () => this.events.started(head, this.now()))
      .then((done) => {
        if (gen !== this.gen) return
        this.playing = null
        if (done) this.events.finished(head)
        this.pump()
      })
    // Playback freed a lookahead slot.
    this.pumpSynth()
  }
}
