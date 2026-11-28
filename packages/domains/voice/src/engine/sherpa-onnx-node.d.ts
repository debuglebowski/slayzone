// The subset of sherpa-onnx-node@2.0.1 the engine uses (the package ships JSDoc
// typedefs, not .d.ts). Shapes from its types.js / vad.js / non-streaming-*.js.
declare module 'sherpa-onnx-node' {
  // CommonJS (`module.exports = {…}`): consumed as the default import.
  namespace sherpa {
    export interface SpeechSegment {
      start: number
      samples: Float32Array
    }

    export interface VadConfig {
      sileroVad: {
        model: string
        threshold?: number
        minSilenceDuration?: number
        minSpeechDuration?: number
        maxSpeechDuration?: number
        windowSize?: number
      }
      sampleRate: number
      numThreads?: number
      provider?: string
      debug?: boolean
    }

    export class Vad {
      constructor(config: VadConfig, bufferSizeInSeconds: number)
      acceptWaveform(samples: Float32Array): void
      isEmpty(): boolean
      isDetected(): boolean
      pop(): void
      clear(): void
      front(enableExternalBuffer?: boolean): SpeechSegment
      reset(): void
      flush(): void
    }

    export interface OfflineRecognizerConfig {
      featConfig: { sampleRate: number; featureDim: number }
      modelConfig: {
        transducer?: { encoder: string; decoder: string; joiner: string }
        tokens: string
        modelType?: string
        numThreads?: number
        provider?: string
        debug?: boolean | number
      }
      decodingMethod?: string
    }

    export class OfflineStream {
      acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void
    }

    export class OfflineRecognizer {
      constructor(config: OfflineRecognizerConfig)
      static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>
      createStream(): OfflineStream
      decode(stream: OfflineStream): void
      decodeAsync(stream: OfflineStream): Promise<{ text: string }>
      getResult(stream: OfflineStream): { text: string }
    }

    export interface OfflineTtsConfig {
      model: {
        kokoro?: {
          model: string
          voices: string
          tokens: string
          lexicon?: string
          dataDir?: string
        }
        pocket?: Record<string, string | number>
        supertonic?: Record<string, string | number>
        numThreads?: number
        provider?: string
        debug?: boolean
      }
      maxNumSentences?: number
      silenceScale?: number
    }

    export interface GeneratedAudio {
      samples: Float32Array
      sampleRate: number
    }

    export class GenerationConfig {
      constructor(opts: {
        sid?: number
        speed?: number
        silenceScale?: number
        referenceAudio?: Float32Array
        referenceSampleRate?: number
        referenceText?: string
      })
    }

    export function readWave(
      path: string,
      enableExternalBuffer?: boolean
    ): { samples: Float32Array; sampleRate: number }

    export class OfflineTts {
      constructor(config: OfflineTtsConfig)
      static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>
      readonly sampleRate: number
      readonly numSpeakers: number
      generate(obj: {
        text: string
        sid?: number
        speed?: number
        enableExternalBuffer?: boolean
      }): GeneratedAudio
      generateAsync(obj: {
        text: string
        sid?: number
        speed?: number
        generationConfig?: GenerationConfig
        enableExternalBuffer?: boolean
        onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void
      }): Promise<GeneratedAudio>
    }
  }
  export = sherpa
}
