import { abortError, type CloudTtsProvider, type PcmAudio, type TtsProvider } from '../shared'

/**
 * Bring-your-own-key cloud voices, run in the voice engine (the key never reaches a
 * renderer). Plain `fetch`, so the same code works in any Node/Electron/RN runtime.
 *
 * Not verified against the live service here (no key available when written): the
 * request/response shapes follow the official API reference, checked 2026-11-27, and
 * are covered by `cloud-tts.test.ts` against a mocked endpoint.
 */

/**
 * ElevenLabs' replacement for its retiring premade "George" voice ("Eldrin"). Library
 * voices may need adding to an account first: the `voice` setting overrides it.
 */
export const ELEVENLABS_DEFAULT_VOICE = '6WwXjDDEMyNmFG95zycZ'
/** Lowest-latency model (~100 ms median per ElevenLabs). */
export const ELEVENLABS_MODEL = 'eleven_flash_v2_5'
const ELEVENLABS_RATE = 24000

export class ElevenLabsTts implements TtsProvider {
  readonly id = 'elevenlabs'
  readonly sampleRate = ELEVENLABS_RATE

  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string = ELEVENLABS_DEFAULT_VOICE,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async synthesize(sentence: string, signal: AbortSignal): Promise<PcmAudio> {
    if (signal.aborted) throw abortError()
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}` +
      `?output_format=pcm_${ELEVENLABS_RATE}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sentence, model_id: ELEVENLABS_MODEL }),
        signal
      })
    } catch (err) {
      if (signal.aborted) throw abortError()
      throw new Error(`ElevenLabs unreachable: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new Error(await elevenLabsError(res))
    const bytes = await res.arrayBuffer()
    if (signal.aborted) throw abortError()
    return { pcm: pcm16ToFloat32(bytes), sampleRate: ELEVENLABS_RATE }
  }
}

/** A readable reason from an ElevenLabs error response (`{detail:{code,message}}`). */
async function elevenLabsError(res: Response): Promise<string> {
  let code = ''
  let message = ''
  try {
    const body = (await res.json()) as { detail?: unknown }
    const detail = body.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const d = detail as { code?: unknown; message?: unknown }
      code = typeof d.code === 'string' ? d.code : ''
      message = typeof d.message === 'string' ? d.message : ''
    } else if (typeof detail === 'string') {
      message = detail
    }
  } catch {
    // not JSON
  }
  if (res.status === 401 || code === 'invalid_api_key') return 'ElevenLabs rejected the API key'
  if (res.status === 402 || code === 'payment_required') return 'ElevenLabs: out of credits'
  if (res.status === 429) return `ElevenLabs rate limit${message ? `: ${message}` : ''}`
  if (res.status === 404) return 'ElevenLabs: voice not found (set another voice id)'
  return `ElevenLabs error ${res.status}${message ? `: ${message}` : ''}`
}

/** Raw 16-bit signed little-endian mono PCM → samples in [-1, 1]. */
export function pcm16ToFloat32(bytes: ArrayBuffer): Float32Array {
  const view = new DataView(bytes)
  const n = Math.floor(bytes.byteLength / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

export function createCloudTts(
  provider: CloudTtsProvider,
  apiKey: string,
  voice?: string
): TtsProvider & { readonly sampleRate: number } {
  switch (provider) {
    case 'elevenlabs':
      return new ElevenLabsTts(apiKey, voice || ELEVENLABS_DEFAULT_VOICE)
  }
}
