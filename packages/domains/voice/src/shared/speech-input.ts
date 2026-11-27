import type { SttProvider, VadProvider, VadSegment } from './providers'

export interface SpeechInputEvents {
  speechStart(at: number): void
  /** A segment's speech ended at `at` (its transcript follows, in order). */
  speechEnd(segmentId: number, at: number): void
  transcript(segmentId: number, text: string, at: number, sttMs: number): void
  error(message: string): void
}

/**
 * Mic frames → VAD → STT per segment. Transcripts come back strictly in segment
 * order (one STT at a time), so the turn buffer never reorders words.
 */
export class SpeechInput {
  private received = 0
  private nextSegment = 1
  private chain: Promise<void> = Promise.resolve()
  private readonly unsubscribe: Array<() => void>

  constructor(
    private readonly vad: VadProvider,
    private readonly stt: SttProvider,
    private readonly now: () => number,
    private readonly events: SpeechInputEvents
  ) {
    this.unsubscribe = [
      vad.onSpeechStart(() => events.speechStart(now())),
      vad.onSegment((segment) => this.segment(segment))
    ]
  }

  /** Mic audio at the VAD's sample rate. */
  accept(frame: Float32Array): void {
    this.received += frame.length
    this.vad.accept(frame)
  }

  reset(): void {
    this.vad.reset()
  }

  dispose(): void {
    for (const off of this.unsubscribe) off()
  }

  private segment(segment: VadSegment): void {
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
