/**
 * Conversation mode (voice loop) end to end, with the real local models: a fake
 * mic is fed speech that the app's own voice engine synthesized (Kokoro), the
 * engine's VAD + Parakeet transcribe it, the keyword ends the turn, the scripted
 * agent's streamed reply is spoken back — and talking over it (barge-in) stops it
 * and tells the agent where it was cut off.
 *
 * Needs the voice models (~800 MB, not in the repo):
 *   pnpm --filter @slayzone/voice models --dir <dir>
 *   SLAYZONE_E2E_VOICE_MODELS_DIR=<dir> pnpm test:e2e e2e/chat/187-chat-voice-mode.spec.ts
 * Skipped when the variable is unset.
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { cliRoot, resetApp } from '../fixtures/electron'
import { ev, expect, step, streamMessage, test } from '../fixtures/chat'

const MODELS = process.env.SLAYZONE_E2E_VOICE_MODELS_DIR

/** Fake mic: getUserMedia returns a stream this page can speak into. */
async function installFakeMic(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    if (w.__fakeMic) return
    const ctx = new AudioContext({ sampleRate: 16000 })
    const dest = ctx.createMediaStreamDestination()
    navigator.mediaDevices.getUserMedia = async () => dest.stream
    w.__fakeMic = {
      ctx,
      play: (samples: number[]) =>
        new Promise<void>((resolve) => {
          const buffer = ctx.createBuffer(1, samples.length, 16000)
          buffer.copyToChannel(Float32Array.from(samples), 0)
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(dest)
          source.onended = () => resolve()
          void ctx.resume().then(() => source.start())
        })
    }
  })
}

/** Speech for `text`, synthesized by the app's own voice engine, at 16 kHz. */
async function synthesize(page: Page, text: string): Promise<number[]> {
  return page.evaluate(async (sentence) => {
    const api = (window as unknown as { api: { voiceHost: { connect(id: string): void } } }).api
    const requestId = `e2e-${Math.random()}`
    const [control] = await new Promise<readonly MessagePort[]>((resolve) => {
      const onMessage = (e: MessageEvent) => {
        if ((e.data as { requestId?: string })?.requestId !== requestId) return
        window.removeEventListener('message', onMessage)
        resolve(e.ports)
      }
      window.addEventListener('message', onMessage)
      api.voiceHost.connect(requestId)
    })
    const reply = (type: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        control.onmessage = (e) => {
          const m = e.data as Record<string, unknown>
          if (m.type === type) resolve(m)
          else if (m.type === 'error' || m.type === 'models-missing')
            reject(new Error(JSON.stringify(m)))
        }
      })
    const ready = reply('ready')
    control.postMessage({ type: 'start' })
    await ready
    const done = reply('synthesized')
    control.postMessage({ type: 'synthesize', id: 1, text: sentence })
    const out = (await done) as { pcm: Float32Array; sampleRate: number }
    control.postMessage({ type: 'stop' })
    // Linear resample to the mic's 16 kHz, plus 0.4 s of silence after.
    const ratio = out.sampleRate / 16000
    const n = Math.floor(out.pcm.length / ratio)
    const pcm = new Array<number>(n + 6400).fill(0)
    for (let i = 0; i < n; i++) {
      const x = i * ratio
      const a = Math.floor(x)
      const b = Math.min(a + 1, out.pcm.length - 1)
      pcm[i] = out.pcm[a] + (out.pcm[b] - out.pcm[a]) * (x - a)
    }
    return pcm
  }, text)
}

async function speak(page: Page, samples: number[]): Promise<void> {
  await page.evaluate(
    (s) =>
      (window as unknown as { __fakeMic: { play(s: number[]): Promise<void> } }).__fakeMic.play(s),
    samples
  )
}

const REPLY_1 = [
  'The build on main is green again. ',
  'The flaky login test was waiting on a fixed timeout, and I replaced it with a wait for the element. ',
  'I also found two other specs with the same pattern, and fixed them the same way. ',
  'All three now pass ten times in a row on my machine. '
]

test.describe('Chat: conversation mode (voice)', () => {
  test.skip(!MODELS, 'SLAYZONE_E2E_VOICE_MODELS_DIR not set (voice models are a separate download)')

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    // The engine reads `<client root>/voice-models` (the future module's location).
    const clientRoot = path.join(await cliRoot(electronApp), 'dev', 'client')
    mkdirSync(clientRoot, { recursive: true })
    const link = path.join(clientRoot, 'voice-models')
    if (!existsSync(link)) symlinkSync(MODELS!, link)
  })

  test('hands-free turns, spoken replies, barge-in note', async ({ chat }) => {
    test.setTimeout(180_000)
    const t = await chat.openTask({
      title: 'Voice mode',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                ...streamMessage('msg_v1', [{ text: REPLY_1 }], { gapMs: 120 }),
                step.emit(ev.result({ text: REPLY_1.join('') }))
              ],
              [
                step.emit(ev.init()),
                ...streamMessage('msg_v2', [{ text: ['Short version: ', 'all green.'] }], {
                  gapMs: 50
                }),
                step.emit(ev.result({ text: 'Short version: all green.' }))
              ]
            ]
          }
        ]
      }
    })
    const page = t.page
    await installFakeMic(page)
    const turn1 = await synthesize(page, 'Check the build status on main, over.')
    const turn2 = await synthesize(page, 'Stop. Just give me the short version. Over.')

    const toggle = t.panel.getByTestId('voice-mode-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-voice-state', 'running', { timeout: 60_000 })

    const voiceLog = () =>
      page.evaluate(
        () =>
          (window as unknown as { __slayzoneVoice?: { log: string[] } }).__slayzoneVoice?.log ?? []
      )
    // Turn 1: spoken, ended by the keyword, sent through the chat with the primer.
    await speak(page, turn1)
    const run = await t
      .run(0, (r) => r.userMessages().length >= 1, 20_000)
      .catch(async (err: unknown) => {
        const mic = await page.evaluate(
          () => (window as unknown as { __fakeMic: { ctx: AudioContext } }).__fakeMic.ctx.state
        )
        console.log(`[voice e2e] fake mic ${mic}; log:\n${(await voiceLog()).join('\n')}`)
        throw err
      })
    const first = run.userMessages()[0]
    expect(first).toContain('[voice mode:')
    // Not the first words: Pocket TTS, which voices the fake mic, often swallows them.
    expect(first.toLowerCase()).toContain('status on main')
    expect(first.toLowerCase()).not.toMatch(/over\.?\s*$/)

    // The reply is spoken…
    await expect(toggle).toHaveAttribute('data-voice-activity', 'speaking', { timeout: 20_000 })
    await page.waitForTimeout(1500)
    // …and talking over it stops it at once.
    const bargeIn = speak(page, turn2)
    await expect(toggle).not.toHaveAttribute('data-voice-activity', 'speaking', { timeout: 2_000 })
    await bargeIn

    // Turn 2 carries where turn 1's reply was cut off.
    await t.run(0, (r) => r.userMessages().length >= 2, 20_000)
    const second = run.userMessages()[1]
    expect(second.startsWith('[voice]\n')).toBe(true)
    expect(second).toMatch(/\[interrupted (during sentence \d+: "[^"]+"|after sentence \d+)/)
    expect(second.toLowerCase()).toContain('short version')
    console.log(`[voice e2e] turn 2 as sent: ${JSON.stringify(second)}`)

    // Its reply is spoken to the end; the loop goes back to listening.
    await expect(toggle).toHaveAttribute('data-voice-activity', 'speaking', { timeout: 20_000 })
    await expect(toggle).toHaveAttribute('data-voice-activity', 'listening', { timeout: 20_000 })

    const latency = await page.evaluate(() => {
      const v = (window as unknown as { __slayzoneVoice?: { samples: unknown[] } }).__slayzoneVoice
      return v?.samples ?? []
    })
    console.log('[voice e2e] turn latencies (ms):', JSON.stringify(latency))
    expect(latency.length).toBeGreaterThanOrEqual(1)

    // Off: the mic closes.
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-voice-state', 'off')
  })

  test('a cloud voice without a key says so instead of starting', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Voice mode cloud no key',
      scenario: { processes: [{ turns: [] }] }
    })
    await installFakeMic(t.page)
    await t.panel.getByTestId('voice-settings').click()
    await t.page.getByRole('button', { name: /ElevenLabs/ }).click()
    await expect(t.page.getByText('API key (not set)')).toBeVisible()
    await t.page.keyboard.press('Escape')

    const toggle = t.panel.getByTestId('voice-mode-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-voice-state', 'error', { timeout: 30_000 })
    await expect(toggle).toHaveAttribute('data-voice-error', /No API key set for ElevenLabs/)

    // Back to the local default for later tests.
    await toggle.click()
    await t.panel.getByTestId('voice-settings').click()
    await t.page.getByRole('button', { name: /Pocket TTS/ }).click()
    await t.page.keyboard.press('Escape')
  })
})
