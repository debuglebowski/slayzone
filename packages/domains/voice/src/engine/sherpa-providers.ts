import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import sherpa from 'sherpa-onnx-node'
import {
  abortError,
  KOKORO_EN_V0_19,
  PARAKEET_TDT_V3,
  POCKET_TTS_INT8,
  SILERO_VAD,
  SUPERTONIC_3_INT8,
  VOICE_SAMPLE_RATE,
  type PcmAudio,
  type SttProvider,
  type TtsProvider,
  type VadProvider,
  type VadSegment,
  type VoiceModelSpec
} from '../shared'

/**
 * Local providers on sherpa-onnx (Node addon, N-API — ABI-stable across Node and
 * Electron). Audio buffers are always copied out of the addon
 * (`enableExternalBuffer: false`): Electron refuses external buffers.
 */

/** Threads per model: STT and TTS can run at the same time (barge-in during synthesis). */
export function defaultThreads(): number {
  return Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))
}

export function missingModels(dir: string, specs: readonly VoiceModelSpec[]): string[] {
  return specs.flatMap((s) =>
    s.files.filter((f) => !existsSync(join(dir, f.installed))).map((f) => f.installed)
  )
}

// ---- VAD -------------------------------------------------------------------

export interface SileroVadOptions {
  threshold?: number
  /** Silence that ends a segment. Short: the keyword check waits its own 300 ms anyway. */
  minSilenceMs?: number
  minSpeechMs?: number
  maxSpeechS?: number
  /**
   * Audio prepended before each segment's start. Default 0: on the bench, 100–250 ms
   * of leading near-silence made Parakeet hallucinate on a lone "Over." (63 → 58 of 66).
   */
  preRollMs?: number
}

const WINDOW = 512

export class SileroVad implements VadProvider {
  readonly id = 'silero-vad'
  readonly sampleRate = VOICE_SAMPLE_RATE
  private readonly vad: sherpa.Vad
  private pending = new Float32Array(0)
  private detected = false
  private segmentSinceStart = false
  private consumed = 0
  /** The last `history.length` samples fed, by stream index (for the pre-roll). */
  private readonly history: Float32Array
  private readonly preRoll: number
  private readonly startCbs = new Set<() => void>()
  private readonly segmentCbs = new Set<(s: VadSegment) => void>()

  constructor(modelsDir: string, opts: SileroVadOptions = {}) {
    const maxSpeechS = opts.maxSpeechS ?? 20
    this.preRoll = Math.round(((opts.preRollMs ?? 0) / 1000) * VOICE_SAMPLE_RATE)
    // A whole segment plus its pre-roll and a margin fit, so the pre-roll is always there.
    this.history = new Float32Array((maxSpeechS + 2) * VOICE_SAMPLE_RATE)
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: join(modelsDir, SILERO_VAD.files[0].installed),
          threshold: opts.threshold ?? 0.5,
          minSilenceDuration: (opts.minSilenceMs ?? 150) / 1000,
          minSpeechDuration: (opts.minSpeechMs ?? 200) / 1000,
          maxSpeechDuration: maxSpeechS,
          windowSize: WINDOW
        },
        sampleRate: VOICE_SAMPLE_RATE,
        numThreads: 1
      },
      60
    )
  }

  accept(frame: Float32Array): void {
    let buf = frame
    if (this.pending.length > 0) {
      buf = new Float32Array(this.pending.length + frame.length)
      buf.set(this.pending)
      buf.set(frame, this.pending.length)
    }
    let off = 0
    for (; off + WINDOW <= buf.length; off += WINDOW) this.window(buf.subarray(off, off + WINDOW))
    this.pending = buf.slice(off)
  }

  private window(chunk: Float32Array): void {
    this.vad.acceptWaveform(chunk)
    this.remember(chunk)
    this.consumed += chunk.length
    let segments = 0
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false)
      this.vad.pop()
      segments++
      this.segmentSinceStart = true
      const startSample = Math.max(0, seg.start - this.preRoll, this.consumed - this.history.length)
      const pcm = new Float32Array(seg.start - startSample + seg.samples.length)
      pcm.set(this.recall(startSample, seg.start))
      pcm.set(seg.samples, seg.start - startSample)
      for (const cb of this.segmentCbs) {
        cb({
          pcm,
          sampleRate: VOICE_SAMPLE_RATE,
          startSample,
          endSample: seg.start + seg.samples.length
        })
      }
    }
    const now = this.vad.isDetected()
    if (now && (!this.detected || segments > 0)) {
      // Speech began — or a max-length cut emitted a segment mid-speech, and the
      // speech goes on: it is a new start for the listeners either way.
      this.segmentSinceStart = false
      for (const cb of this.startCbs) cb()
    } else if (!now && this.detected && !this.segmentSinceStart) {
      // Detected, then gone without a segment (too short to keep): close it so
      // listeners never wait for a segment that will not come.
      for (const cb of this.segmentCbs) {
        cb({
          pcm: new Float32Array(0),
          sampleRate: VOICE_SAMPLE_RATE,
          startSample: this.consumed,
          endSample: this.consumed
        })
      }
    }
    this.detected = now
  }

  /** Append fed samples (stream index `consumed…`) to the history ring. */
  private remember(chunk: Float32Array): void {
    const n = this.history.length
    for (let i = 0; i < chunk.length; i++) this.history[(this.consumed + i) % n] = chunk[i]
  }

  /** Samples [from, to) of the stream, from the history ring. */
  private recall(from: number, to: number): Float32Array {
    const n = this.history.length
    const out = new Float32Array(Math.max(0, to - from))
    for (let i = 0; i < out.length; i++) out[i] = this.history[(from + i) % n]
    return out
  }

  onSpeechStart(cb: () => void): () => void {
    this.startCbs.add(cb)
    return () => this.startCbs.delete(cb)
  }

  onSegment(cb: (segment: VadSegment) => void): () => void {
    this.segmentCbs.add(cb)
    return () => this.segmentCbs.delete(cb)
  }

  isSpeaking(): boolean {
    return this.detected
  }

  reset(): void {
    this.vad.reset()
    this.pending = new Float32Array(0)
    this.detected = false
    this.segmentSinceStart = false
  }
}

// ---- STT -------------------------------------------------------------------

/** Silence padded after a segment: the transducer drops a clipped last word (the keyword!). */
const TAIL_PAD_S = 0.1

export class ParakeetStt implements SttProvider {
  readonly id = 'parakeet-tdt-0.6b-v3'

  private constructor(
    private readonly rec: sherpa.OfflineRecognizer,
    private readonly tailPadS: number
  ) {}

  static async load(
    modelsDir: string,
    opts: { numThreads?: number; tailPadS?: number } = {}
  ): Promise<ParakeetStt> {
    const numThreads = opts.numThreads ?? defaultThreads()
    const dir = join(modelsDir, PARAKEET_TDT_V3.files[0].installed)
    const rec = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(dir, 'encoder.int8.onnx'),
          decoder: join(dir, 'decoder.int8.onnx'),
          joiner: join(dir, 'joiner.int8.onnx')
        },
        tokens: join(dir, 'tokens.txt'),
        modelType: 'nemo_transducer',
        numThreads,
        provider: 'cpu'
      },
      // modified_beam_search on TDT drops / hallucinates text (k2-fsa/sherpa-onnx#3267).
      decodingMethod: 'greedy_search'
    })
    return new ParakeetStt(rec, opts.tailPadS ?? TAIL_PAD_S)
  }

  async transcribeSegment(pcm: Float32Array, sampleRate: number): Promise<string> {
    if (pcm.length === 0) return ''
    const padded = new Float32Array(pcm.length + Math.round(this.tailPadS * sampleRate))
    padded.set(pcm)
    const stream = this.rec.createStream()
    stream.acceptWaveform({ sampleRate, samples: padded })
    const result = await this.rec.decodeAsync(stream)
    return result.text.trim()
  }
}

// ---- TTS -------------------------------------------------------------------

export interface KokoroOptions {
  /** Speaker id (kokoro-en-v0_19 has 11; 0 = af). */
  sid?: number
  speed?: number
  numThreads?: number
}

export class KokoroTts implements TtsProvider {
  readonly id = 'kokoro-82m'

  private constructor(
    private readonly tts: sherpa.OfflineTts,
    private readonly opts: KokoroOptions
  ) {}

  get sampleRate(): number {
    return this.tts.sampleRate
  }

  static async load(modelsDir: string, opts: KokoroOptions = {}): Promise<KokoroTts> {
    const dir = join(modelsDir, KOKORO_EN_V0_19.files[0].installed)
    const tts = await sherpa.OfflineTts.createAsync({
      model: {
        kokoro: {
          model: join(dir, 'model.onnx'),
          voices: join(dir, 'voices.bin'),
          tokens: join(dir, 'tokens.txt'),
          lexicon: join(modelsDir, KOKORO_EN_V0_19.files[1].installed)
        },
        numThreads: opts.numThreads ?? defaultThreads(),
        provider: 'cpu'
      },
      maxNumSentences: 1
    })
    return new KokoroTts(tts, opts)
  }

  /** `voice` overrides the instance's speaker / speed for this sentence. */
  async synthesize(
    sentence: string,
    signal: AbortSignal,
    voice?: Pick<KokoroOptions, 'sid' | 'speed'>
  ): Promise<PcmAudio> {
    if (signal.aborted) throw abortError()
    const audio = await this.tts.generateAsync({
      text: sentence,
      sid: voice?.sid ?? this.opts.sid ?? 0,
      speed: voice?.speed ?? this.opts.speed ?? 1.0,
      enableExternalBuffer: false,
      // Returning 0 stops generation (between chunks).
      onProgress: () => (signal.aborted ? 0 : 1)
    })
    if (signal.aborted) throw abortError()
    return { pcm: audio.samples, sampleRate: audio.sampleRate }
  }
}

/**
 * Pocket TTS (Kyutai, int8): zero-shot voice from a reference clip. Optional —
 * evaluated next to Kokoro for long technical replies; not the default.
 */
export class PocketTts implements TtsProvider {
  readonly id = 'pocket-tts'

  private constructor(
    private readonly tts: sherpa.OfflineTts,
    private readonly reference: { samples: Float32Array; sampleRate: number }
  ) {}

  get sampleRate(): number {
    return this.tts.sampleRate
  }

  static async load(
    modelsDir: string,
    opts: { referenceWav?: string; numThreads?: number } = {}
  ): Promise<PocketTts> {
    const dir = join(modelsDir, POCKET_TTS_INT8.files[0].installed)
    const tts = await sherpa.OfflineTts.createAsync({
      model: {
        pocket: {
          lmFlow: join(dir, 'lm_flow.int8.onnx'),
          lmMain: join(dir, 'lm_main.int8.onnx'),
          encoder: join(dir, 'encoder.onnx'),
          decoder: join(dir, 'decoder.int8.onnx'),
          textConditioner: join(dir, 'text_conditioner.onnx'),
          vocabJson: join(dir, 'vocab.json'),
          tokenScoresJson: join(dir, 'token_scores.json')
        },
        numThreads: opts.numThreads ?? defaultThreads(),
        provider: 'cpu'
      },
      maxNumSentences: 1
    })
    const reference = sherpa.readWave(
      opts.referenceWav ?? join(dir, 'test_wavs', 'bria.wav'),
      false
    )
    return new PocketTts(tts, reference)
  }

  async synthesize(sentence: string, signal: AbortSignal): Promise<PcmAudio> {
    if (signal.aborted) throw abortError()
    const audio = await this.tts.generateAsync({
      text: sentence,
      generationConfig: new sherpa.GenerationConfig({
        referenceAudio: this.reference.samples,
        referenceSampleRate: this.reference.sampleRate
      }),
      enableExternalBuffer: false,
      onProgress: () => (signal.aborted ? 0 : 1)
    })
    if (signal.aborted) throw abortError()
    return { pcm: audio.samples, sampleRate: audio.sampleRate }
  }
}

/** Supertonic 3 (int8): character-level (no lexicon), fixed voice. Optional. */
export class SupertonicTts implements TtsProvider {
  readonly id = 'supertonic-3'

  private constructor(private readonly tts: sherpa.OfflineTts) {}

  get sampleRate(): number {
    return this.tts.sampleRate
  }

  static async load(modelsDir: string, opts: { numThreads?: number } = {}): Promise<SupertonicTts> {
    const dir = join(modelsDir, SUPERTONIC_3_INT8.files[0].installed)
    const tts = await sherpa.OfflineTts.createAsync({
      model: {
        supertonic: {
          durationPredictor: join(dir, 'duration_predictor.int8.onnx'),
          textEncoder: join(dir, 'text_encoder.int8.onnx'),
          vectorEstimator: join(dir, 'vector_estimator.int8.onnx'),
          vocoder: join(dir, 'vocoder.int8.onnx'),
          ttsJson: join(dir, 'tts.json'),
          unicodeIndexer: join(dir, 'unicode_indexer.bin'),
          voiceStyle: join(dir, 'voice.bin')
        },
        numThreads: opts.numThreads ?? defaultThreads(),
        provider: 'cpu'
      },
      maxNumSentences: 1
    })
    return new SupertonicTts(tts)
  }

  async synthesize(sentence: string, signal: AbortSignal): Promise<PcmAudio> {
    if (signal.aborted) throw abortError()
    const audio = await this.tts.generateAsync({
      text: sentence,
      sid: 0,
      speed: 1.0,
      enableExternalBuffer: false,
      onProgress: () => (signal.aborted ? 0 : 1)
    })
    if (signal.aborted) throw abortError()
    return { pcm: audio.samples, sampleRate: audio.sampleRate }
  }
}
