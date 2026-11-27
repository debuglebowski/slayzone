import { KOKORO_EN_V0_19, POCKET_TTS_INT8, SUPERTONIC_3_INT8, type VoiceModelSpec } from './models'

/**
 * The voices conversation mode can speak with. Local ones run on this device from
 * the downloadable models; cloud ones are bring-your-own-key (SlayZone never ships
 * a key; the key stays on this device, encrypted, and only the voice engine reads it).
 */
// OpenAI is left out on purpose: its /v1/audio/speech models retire 2027-01-06 and
// the replacement is Realtime-API only.
export type CloudTtsProvider = 'elevenlabs'
export type TtsChoice = 'pocket' | 'supertonic' | 'kokoro' | CloudTtsProvider

export type TtsCatalogEntry =
  | {
      id: Exclude<TtsChoice, CloudTtsProvider>
      label: string
      kind: 'local'
      model: VoiceModelSpec
    }
  | { id: CloudTtsProvider; label: string; kind: 'cloud'; keyHint: string }

export const TTS_CATALOG: readonly TtsCatalogEntry[] = [
  { id: 'pocket', label: 'Pocket TTS (local)', kind: 'local', model: POCKET_TTS_INT8 },
  { id: 'supertonic', label: 'Supertonic 3 (local)', kind: 'local', model: SUPERTONIC_3_INT8 },
  { id: 'kokoro', label: 'Kokoro (local, skips jargon)', kind: 'local', model: KOKORO_EN_V0_19 },
  { id: 'elevenlabs', label: 'ElevenLabs (your key)', kind: 'cloud', keyHint: 'xi-api-key' }
]

export const DEFAULT_TTS: TtsChoice = 'pocket'

export function ttsEntry(id: TtsChoice): TtsCatalogEntry {
  return TTS_CATALOG.find((e) => e.id === id) ?? TTS_CATALOG[0]
}

export function isTtsChoice(value: unknown): value is TtsChoice {
  return TTS_CATALOG.some((e) => e.id === value)
}

export function isCloudTts(id: TtsChoice): id is CloudTtsProvider {
  return ttsEntry(id).kind === 'cloud'
}
