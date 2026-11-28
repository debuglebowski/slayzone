/**
 * The local voice models: an optional downloadable module, never in the app
 * bundle. The same files serve the desktop (sherpa-onnx-node) and, later, the
 * phone (react-native-sherpa-onnx). Paths are relative to the models directory
 * (desktop: `<client root>/voice-models`, see `voiceModelsDir`).
 *
 * Pinned: runtime `sherpa-onnx-node@2.0.1`, models from k2-fsa/sherpa-onnx
 * GitHub releases. Packaging/downloading as a module is future work; until then
 * `pnpm --filter @slayzone/voice models` fetches them.
 */

export const SHERPA_ONNX_VERSION = '2.0.1'

export interface VoiceModelFile {
  /** Archive to download (a .tar.bz2 is extracted into the models dir). */
  url: string
  /** Path (in the models dir) that exists once installed. */
  installed: string
  approxMb: number
}

export interface VoiceModelSpec {
  id: string
  role: 'vad' | 'stt' | 'tts'
  label: string
  files: VoiceModelFile[]
}

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'

export const SILERO_VAD: VoiceModelSpec = {
  id: 'silero-vad',
  role: 'vad',
  label: 'Silero VAD',
  files: [
    { url: `${RELEASES}/asr-models/silero_vad.onnx`, installed: 'silero_vad.onnx', approxMb: 1 }
  ]
}

export const PARAKEET_TDT_V3: VoiceModelSpec = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  role: 'stt',
  label: 'Parakeet TDT 0.6B v3 (int8)',
  files: [
    {
      url: `${RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
      installed: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
      approxMb: 490
    }
  ]
}

/**
 * The default TTS. No lexicon: it says identifiers and jargon Kokoro (lexicon-only in
 * sherpa-onnx 2.x) silently skips. Voice from a reference clip; the archive ships
 * `test_wavs/bria.wav`, the default.
 */
export const POCKET_TTS_INT8: VoiceModelSpec = {
  id: 'pocket-tts-int8',
  role: 'tts',
  label: 'Pocket TTS (Kyutai, int8)',
  files: [
    {
      url: `${RELEASES}/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2`,
      installed: 'sherpa-onnx-pocket-tts-int8-2026-01-26',
      approxMb: 98
    }
  ]
}

/** Optional (evaluated): Supertone's Supertonic 3, 31 languages, reads raw characters. */
export const SUPERTONIC_3_INT8: VoiceModelSpec = {
  id: 'supertonic-3-int8',
  role: 'tts',
  label: 'Supertonic 3 (int8)',
  files: [
    {
      url: `${RELEASES}/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`,
      installed: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
      approxMb: 140
    }
  ]
}

/** Optional: faster on long sentences, but skips words not in its lexicon. */
export const KOKORO_EN_V0_19: VoiceModelSpec = {
  id: 'kokoro-en-v0_19',
  role: 'tts',
  label: 'Kokoro 82M (English)',
  files: [
    {
      url: `${RELEASES}/tts-models/kokoro-en-v0_19.tar.bz2`,
      installed: 'kokoro-en-v0_19',
      approxMb: 320
    },
    // sherpa-onnx 2.x dropped espeak-ng: Kokoro needs an explicit lexicon.
    { url: `${RELEASES}/tts-models/lexicon-en-us.txt`, installed: 'lexicon-en-us.txt', approxMb: 6 }
  ]
}

/** What the default local voice loop needs. */
export const DEFAULT_VOICE_MODELS: readonly VoiceModelSpec[] = [
  SILERO_VAD,
  PARAKEET_TDT_V3,
  POCKET_TTS_INT8
]

export const ALL_VOICE_MODELS: readonly VoiceModelSpec[] = [
  ...DEFAULT_VOICE_MODELS,
  KOKORO_EN_V0_19,
  SUPERTONIC_3_INT8
]

/** Name of the models directory under the client root (`~/.slayzone/<channel>/client`). */
export const VOICE_MODELS_DIRNAME = 'voice-models'
