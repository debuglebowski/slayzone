import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { TurnLatency } from './latency'
import type { PcmAudio, TtsProvider } from './providers'
import { abortError } from './providers'
import type { AudioSink } from './speech-queue'
import { VOICE_PRIMER, VOICE_TAG, VoiceLoop } from './voice-loop'

const flush = () => new Promise((r) => setTimeout(r, 0))

function harness() {
  let now = 0
  let ids = 0
  const sent: Array<{ text: string; id: string }> = []
  const played: string[] = []
  const latencies: TurnLatency[] = []
  let current: { text: string; resolve: (done: boolean) => void } | null = null
  let tones = 0
  const tts: TtsProvider = {
    id: 'fake',
    synthesize: (text, signal) =>
      signal.aborted
        ? Promise.reject(abortError())
        : Promise.resolve({ pcm: new Float32Array([text.length]), sampleRate: 24000 })
  }
  const textOf = (a: PcmAudio) => a.pcm[0]
  const byLen = new Map<number, string>()
  const sink: AudioSink = {
    play: (audio, onStart) =>
      new Promise<boolean>((resolve) => {
        const text = byLen.get(textOf(audio)) ?? '?'
        played.push(text)
        current = { text, resolve }
        onStart()
      }),
    stop: () => {
      current?.resolve(false)
      current = null
    },
    tone: () => {
      tones++
    }
  }
  const loop = new VoiceLoop({
    now: () => now,
    newId: () => `v${++ids}`,
    tts: {
      id: 'fake',
      synthesize: (text, signal) => {
        byLen.set(text.length, text)
        return tts.synthesize(text, signal)
      }
    },
    sink,
    sendTurn: (text, id) => {
      sent.push({ text, id })
      return Promise.resolve()
    },
    onLatency: (s) => latencies.push(s)
  })
  return {
    loop,
    sent,
    played,
    latencies,
    tones: () => tones,
    at: (t: number) => {
      now = t
    },
    /** Finish the sentence playing now. */
    finishPlaying: async () => {
      const c = current
      current = null
      c?.resolve(true)
      await flush()
    },
    playing: () => current?.text ?? null,
    async say(text: string, endAt: number) {
      now = endAt - 500
      loop.speechStarted()
      loop.speechEnded(endAt)
      now = endAt + 150
      loop.transcript(text, now)
      now = endAt + 320
      loop.tick()
      await flush()
    }
  }
}

function reply(
  messageId: string,
  exec: { turnId: string; messageId?: string },
  chunks: string[]
): AgentEvent[] {
  const execution = { turnId: exec.turnId, source: 'provider' as const, messageId: exec.messageId }
  return [
    { kind: 'stream-message-start', messageId, execution },
    { kind: 'stream-block-start', blockIndex: 0, blockType: 'text', execution },
    ...chunks.map(
      (text): AgentEvent => ({
        kind: 'stream-block-delta',
        blockIndex: 0,
        deltaType: 'text',
        text,
        execution
      })
    ),
    { kind: 'stream-block-stop', blockIndex: 0, execution },
    { kind: 'stream-message-stop', execution },
    // The saved copy of the same message: a duplicate, never spoken twice.
    { kind: 'assistant-text', messageId, text: chunks.join(''), execution }
  ] as AgentEvent[]
}

function result(turnId: string, messageId?: string): AgentEvent {
  return {
    kind: 'result',
    subtype: 'success',
    isError: false,
    durationMs: 1,
    durationApiMs: 1,
    numTurns: 1,
    execution: { turnId, source: 'provider', messageId }
  } as unknown as AgentEvent
}

describe('VoiceLoop', () => {
  it('multi-turn: keyword sends, the reply is spoken sentence by sentence', async () => {
    const h = harness()
    await h.say('Check the build, over.', 1000)
    expect(h.sent).toEqual([{ id: 'v1', text: `${VOICE_PRIMER}\nCheck the build` }])

    h.at(1600)
    for (const e of reply('m1', { turnId: 't1', messageId: 'v1' }, [
      'The build ',
      'passed. Deploy',
      ' next?'
    ]))
      h.loop.agentEvent(e)
    h.loop.agentEvent(result('t1', 'v1'))
    await flush()
    expect(h.played).toEqual(['The build passed.'])
    await h.finishPlaying()
    expect(h.played).toEqual(['The build passed.', 'Deploy next?'])
    await h.finishPlaying()

    expect(h.latencies).toHaveLength(1)
    expect(h.latencies[0]).toMatchObject({
      sttMs: 150,
      sentMs: 320,
      firstTokenMs: 600,
      firstAudioMs: 600
    })

    await h.say('Yes, over', 5000)
    expect(h.sent[1]).toEqual({ id: 'v2', text: `${VOICE_TAG}\nYes` })
  })

  it('barge-in stops playback and the next turn carries the cut-off note', async () => {
    const h = harness()
    await h.say('Explain the diff over', 1000)
    for (const e of reply('m1', { turnId: 't1', messageId: 'v1' }, [
      'First point. Second point. Third point. '
    ]))
      h.loop.agentEvent(e)
    await flush()
    await h.finishPlaying()
    expect(h.playing()).toBe('Second point.')

    // The user talks over sentence 2; the agent's turn keeps streaming.
    h.loop.speechStarted()
    expect(h.playing()).toBeNull()
    for (const e of reply('m2', { turnId: 't1', messageId: 'v1' }, ['More text after. ']))
      h.loop.agentEvent(e)
    h.loop.agentEvent(result('t1', 'v1'))
    await flush()
    expect(h.played).toEqual(['First point.', 'Second point.'])

    h.loop.speechEnded(3000)
    h.at(3150)
    h.loop.transcript('Stop, just the summary. Over.', 3150)
    h.at(3400)
    h.loop.tick()
    expect(h.sent[1].text).toBe(
      `${VOICE_TAG}\n[interrupted during sentence 2: "Second point."; later sentences were not heard]\nStop, just the summary.`
    )
  })

  it('holds an unprompted message while the user is mid-turn, then speaks it', async () => {
    const h = harness()
    h.at(1000)
    h.loop.speechStarted()
    h.loop.speechEnded(1500)
    h.loop.transcript('so the next thing', 1600)
    h.loop.tick()
    for (const e of reply('u1', { turnId: 'bg' }, ['Background job finished. ']))
      h.loop.agentEvent(e)
    h.loop.agentEvent(result('bg'))
    await flush()
    expect(h.played).toEqual([])

    await h.say('is the deploy, over', 3000)
    expect(h.sent[0].text).toContain('so the next thing is the deploy')
    expect(h.played).toEqual(['Background job finished.'])
  })

  it('never speaks a no-speak message', async () => {
    const h = harness()
    await h.say('show me the diff over', 1000)
    for (const e of reply('m1', { turnId: 't1', messageId: 'v1' }, [
      '[no-',
      'speak] Here is the diff. Line one.'
    ]))
      h.loop.agentEvent(e)
    for (const e of reply('m2', { turnId: 't1', messageId: 'v1' }, ['That was the diff.']))
      h.loop.agentEvent(e)
    h.loop.agentEvent(result('t1', 'v1'))
    await flush()
    expect(h.played).toEqual(['That was the diff.'])
  })

  it('plays the fallback tone, then sends without a keyword', async () => {
    const h = harness()
    await h.say('rename the module', 1000)
    expect(h.sent).toEqual([])
    h.at(9000)
    h.loop.tick()
    expect(h.tones()).toBe(1)
    h.at(11_000)
    h.loop.tick()
    expect(h.sent[0].text).toBe(`${VOICE_PRIMER}\nrename the module`)
  })
})
