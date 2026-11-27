/**
 * The swappable voice providers. Local implementations (sherpa-onnx) live in
 * `../engine`; cloud bring-your-own-key implementations plug in behind the same
 * interfaces later. Nothing here knows about Electron, Node or the DOM, so the
 * React Native client implements the same contracts.
 */

/** Mono PCM, samples in [-1, 1]. */
export interface PcmAudio {
  pcm: Float32Array
  sampleRate: number
}

/** Speech to text for one finished speech segment (VAD-delimited). */
export interface SttProvider {
  readonly id: string
  transcribeSegment(pcm: Float32Array, sampleRate: number): Promise<string>
  dispose?(): void
}

/** Text to speech for one sentence. Rejects with an `AbortError` once `signal` aborts. */
export interface TtsProvider {
  readonly id: string
  synthesize(sentence: string, signal: AbortSignal): Promise<PcmAudio>
  dispose?(): void
}

/** One finished stretch of speech, as the VAD cut it. */
export interface VadSegment {
  pcm: Float32Array
  sampleRate: number
  /** Index (in the provider's input stream) of the segment's first / one-past-last sample. */
  startSample: number
  endSample: number
}

/**
 * Voice activity detection over a continuous mic stream. The caller feeds frames
 * at the provider's `sampleRate`; speech start fires as soon as speech is
 * detected, a segment once it has ended (after the provider's own min silence).
 */
export interface VadProvider {
  readonly id: string
  readonly sampleRate: number
  accept(frame: Float32Array): void
  onSpeechStart(cb: () => void): () => void
  onSegment(cb: (segment: VadSegment) => void): () => void
  /** Speech is going on right now. */
  isSpeaking(): boolean
  reset(): void
  dispose?(): void
}

export function abortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
