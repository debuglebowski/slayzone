import { describe, expect, it } from 'vitest'
import { isAbortError } from '../shared'
import {
  ELEVENLABS_DEFAULT_VOICE,
  ELEVENLABS_MODEL,
  ElevenLabsTts,
  pcm16ToFloat32
} from './cloud-tts'

function pcmBytes(samples: number[]): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(samples.length * 2))
  samples.forEach((s, i) => view.setInt16(i * 2, s, true))
  return view.buffer
}

describe('ElevenLabsTts', () => {
  it('posts the sentence and decodes 16-bit little-endian PCM', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(pcmBytes([0, 16384, -32768]), { status: 200 })
    }) as unknown as typeof fetch
    const tts = new ElevenLabsTts('k-123', undefined, fake)
    const out = await tts.synthesize('Hello there.', new AbortController().signal)

    expect(calls[0].url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE}?output_format=pcm_24000`
    )
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>)['xi-api-key']).toBe('k-123')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      text: 'Hello there.',
      model_id: ELEVENLABS_MODEL
    })
    expect(out.sampleRate).toBe(24000)
    expect(Array.from(out.pcm)).toEqual([0, 0.5, -1])
  })

  it('turns API errors into readable reasons', async () => {
    const respond = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    const sig = new AbortController().signal
    await expect(
      new ElevenLabsTts(
        'bad',
        'v',
        respond(401, { detail: { code: 'invalid_api_key', message: 'x' } })
      ).synthesize('a', sig)
    ).rejects.toThrow('ElevenLabs rejected the API key')
    await expect(
      new ElevenLabsTts(
        'k',
        'v',
        respond(429, { detail: { code: 'rate_limit_exceeded', message: 'slow down' } })
      ).synthesize('a', sig)
    ).rejects.toThrow('ElevenLabs rate limit: slow down')
    await expect(
      new ElevenLabsTts('k', 'v', respond(404, {})).synthesize('a', sig)
    ).rejects.toThrow('voice not found')
  })

  it('aborts', async () => {
    const ctl = new AbortController()
    const fake = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted by fetch')))
      })) as unknown as typeof fetch
    const pending = new ElevenLabsTts('k', 'v', fake).synthesize('a', ctl.signal)
    ctl.abort()
    await expect(pending).rejects.toSatisfy(isAbortError)
  })

  it('pcm16ToFloat32 ignores a trailing odd byte', () => {
    expect(pcm16ToFloat32(new Uint8Array([0, 64, 7]).buffer).length).toBe(1)
  })
})
