import { DEFAULT_TTS, isTtsChoice, type TtsChoice } from './tts-catalog'
import { DEFAULT_TURN_DETECTOR_CONFIG, type TurnDetectorConfig } from './turn-detector'

/** Settings key (JSON) for the user's voice preferences. Never holds API keys. */
export const VOICE_SETTINGS_KEY = 'voice'

export interface VoiceSettings extends TurnDetectorConfig {
  /** Which voice speaks the replies. */
  tts: TtsChoice
  /**
   * ElevenLabs voice id (empty: the provider's default). Configurable because
   * ElevenLabs' premade voices stop working 2026-12-31 and library voices may need
   * adding to the account first.
   */
  elevenLabsVoiceId: string
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  ...DEFAULT_TURN_DETECTOR_CONFIG,
  tts: DEFAULT_TTS,
  elevenLabsVoiceId: ''
}

/** Settings from their stored JSON; anything missing or malformed takes its default. */
export function parseVoiceSettings(raw: string | null | undefined): VoiceSettings {
  const out: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS }
  if (!raw) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object') return out
  const p = parsed as Record<string, unknown>
  if (typeof p.endKeyword === 'string' && p.endKeyword.trim()) out.endKeyword = p.endKeyword.trim()
  if (typeof p.discardKeyword === 'string' && p.discardKeyword.trim()) {
    out.discardKeyword = p.discardKeyword.trim()
  }
  for (const key of ['keywordSilenceMs', 'fallbackToneMs', 'fallbackEndMs'] as const) {
    const v = p[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v
  }
  if (isTtsChoice(p.tts)) out.tts = p.tts
  if (typeof p.elevenLabsVoiceId === 'string') out.elevenLabsVoiceId = p.elevenLabsVoiceId.trim()
  return out
}
