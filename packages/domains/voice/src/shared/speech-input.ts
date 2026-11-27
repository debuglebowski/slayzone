import type { SttProvider, VadProvider, VadSegment } from './providers'

export interface SpeechInputEvents {
  speechStart(at: number): void
  /**
   * Early words of speech still going on: the first `probeMs` of it (plus the lead-in
   * the VAD needed to notice it), transcribed. Once per speech start, only if the
   * speech lasts that long. Lets the loop tell a word from a cough before the
   * segment ends (barge-in).
   */
  speechProbe(text: string, at: number): void
  /** A segment's speech ended at `at` (its transcript follows, in order). */
  speechEnd(segmentId: number, at: number): void
  transcript(segmentId: number, text: string, at: number, sttMs: number): void
  error(message: string): void
}

export interface SpeechInputOptions {
  /** Speech this long (after the VAD noticed it) gets an early transcription. */
  probeMs?: number
  /** Audio before the VAD noticed speech, included in the probe (detection lags onset). */
  probeLeadMs?: number
}

/** Recent mic audio kept for probes (seconds). */
const RING_S = 4

/**
 * Mic frames → VAD → STT per segment. Transcripts come back strictly in segment
 * order (one STT at a time), so the turn buffer never reorders words.
 */
export class SpeechInput {
  private received = 0
  private nextSegment = 1
  private chain: Promise<void> = Promise.resolve()
  private readonly unsubscribe: Array<() => void>
  private readonly ring: Float32Array
  /** Stream index where the current speech was noticed; null = no probe pending. */
  private probeFrom: number | null = null
  private readonly probeSamples: number
  private readonly leadSamples: number

  constructor(
    private readonly vad: VadProvider,
    private readonly stt: SttProvider,
    private readonly now: () => number,
    private readonly events: SpeechInputEvents,
    opts: SpeechInputOptions = {}
  ) {
    const rate = vad.sampleRate
    this.ring = new Float32Array(RING_S * rate)
    this.probeSamples = Math.round(((opts.probeMs ?? 400) / 1000) * rate)
    this.leadSamples = Math.round(((opts.probeLeadMs ?? 300) / 1000) * rate)
    this.unsubscribe = [
      vad.onSpeechStart(() => {
        this.probeFrom = this.received
        events.speechStart(now())
      }),
      vad.onSegment((segment) => this.segment(segment))
    ]
  }

  /** Mic audio at the VAD's sample rate. */
  accept(frame: Float32Array): void {
    const n = this.ring.length
    for (let i = 0; i < frame.length; i++) this.ring[(this.received + i) % n] = frame[i]
    this.received += frame.length
    this.vad.accept(frame)
    if (this.probeFrom !== null && this.received - this.probeFrom >= this.probeSamples) {
      const from = Math.max(0, this.probeFrom - this.leadSamples, this.received - n)
      this.probeFrom = null
      if (this.vad.isSpeaking()) this.probe(from, this.received)
    }
  }

  reset(): void {
    this.vad.reset()
    this.probeFrom = null
  }

  dispose(): void {
    for (const off of this.unsubscribe) off()
  }

  /** Transcribe stream samples [from, to) now, outside the segment order. */
  private probe(from: number, to: number): void {
    const n = this.ring.length
    const pcm = new Float32Array(to - from)
    for (let i = 0; i < pcm.length; i++) pcm[i] = this.ring[(from + i) % n]
    this.stt.transcribeSegment(pcm, this.vad.sampleRate).then(
      (text) => this.events.speechProbe(text, this.now()),
      // A failed probe decides nothing: the segment's own transcript still will.
      () => undefined
    )
  }

  private segment(segment: VadSegment): void {
    // Speech ended before its probe was due: the segment's transcript decides.
    this.probeFrom = null
    const id = this.nextSegment++
    // The segment ended `received - endSample` samples before the newest frame.
    const lagMs = (Math.max(0, this.received - segment.endSample) / segment.sampleRate) * 1000
    this.events.speechEnd(id, this.now() - lagMs)
    this.chain = this.chain.then(() => {
      const startedAt = this.now()
      return this.stt.transcribeSegment(segment.pcm, segment.sampleRate).then(
        (text) => {
          const at = this.now()
          this.events.transcript(id, text, at, at - startedAt)
        },
        (err: unknown) => {
          this.events.error(`Transcription failed: ${err instanceof Error ? err.message : err}`)
          this.events.transcript(id, '', this.now(), 0)
        }
      )
    })
  }
}
