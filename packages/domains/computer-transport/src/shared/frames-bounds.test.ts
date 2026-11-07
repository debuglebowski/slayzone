/**
 * Strings a computer reports about a terminal (title, prompt text, conversation id,
 * dev-server URLs, error text) and exit signals flow into the hub's state and DB.
 * Unbounded, one runaway OSC title or prompt held megabytes per session. They are
 * bounded — truncated, not rejected, so an oversized title never drops the state
 * signal carrying it.
 */
import { describe, expect, it } from 'vitest'
import { procExitParamsSchema, ptyExitParamsSchema, ptySignalPayloadSchema } from './frames'

const huge = 'x'.repeat(1_000_000)

describe('pty signal bounds', () => {
  it('oversized strings are cut, the signal kept', () => {
    const parsed = ptySignalPayloadSchema.parse({
      sessionId: 's',
      seq: 3,
      activity: 'idle',
      refreshIdleClock: true,
      preview: '',
      error: { code: 'E', message: huge, recoverable: true },
      suppressOutput: false,
      prompt: { type: 'question', text: huge, position: 0 },
      title: huge,
      devServerUrls: Array.from({ length: 500 }, (_, i) => `http://localhost:${i}/${huge}`),
      conversationId: huge
    })
    expect(parsed.activity, 'the state is kept').toBe('idle')
    expect(parsed.title!.length).toBeLessThanOrEqual(1024)
    expect(parsed.prompt!.text.length).toBeLessThanOrEqual(16 * 1024)
    expect(parsed.error!.message.length).toBeLessThanOrEqual(16 * 1024)
    expect(parsed.conversationId!.length).toBeLessThanOrEqual(256)
    expect(parsed.devServerUrls.length).toBeLessThanOrEqual(32)
    for (const url of parsed.devServerUrls) expect(url.length).toBeLessThanOrEqual(2048)
  })

  it('exit signals are bounded too', () => {
    const base = { sessionId: 's', exitCode: null, signal: huge }
    expect(ptyExitParamsSchema.parse(base).signal!.length).toBeLessThanOrEqual(64)
    expect(procExitParamsSchema.parse(base).signal!.length).toBeLessThanOrEqual(64)
  })
})
