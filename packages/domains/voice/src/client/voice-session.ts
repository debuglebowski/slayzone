import type { AgentEvent } from '@slayzone/terminal-contracts'
import {
  latencyStats,
  VOICE_SAMPLE_RATE,
  VoiceLoop,
  voiceNow,
  type TurnLatency,
  type VoiceEngineInfo,
  type VoiceLoopStatus,
  type VoiceSettings
} from '../shared'
import { VoiceEngineClient } from './engine-client'
import { WebAudioSink } from './web-audio-sink'
import captureWorkletUrl from './mic-capture.worklet.ts?worker&url'

export type VoiceSessionPhase = 'starting' | 'running' | 'error'

export interface VoiceSessionStatus {
  phase: VoiceSessionPhase
  error: string | null
  loop: VoiceLoopStatus | null
  engine: VoiceEngineInfo | null
}

export interface VoiceSessionDeps {
  settings: VoiceSettings
  /** The chat's own send (the composer's path), under a caller-chosen message id. */
  sendTurn: (text: string, id: string) => Promise<void>
  /** The chat's agent events, as the chat panel applies them. */
  subscribeEvents: (listener: (event: AgentEvent) => void) => () => void
  onStatus: (status: VoiceSessionStatus) => void
}

/** Latency samples of this renderer's voice turns, for the spike's measurements. */
const samples: TurnLatency[] = []
/** The last engine events and loop decisions (debugging a session by hand or in e2e). */
const log: string[] = []
function note(line: string): void {
  log.push(`${new Date().toISOString().slice(11, 23)} ${line}`)
  if (log.length > 100) log.shift()
}

declare global {
  interface Window {
    __slayzoneVoice?: {
      samples: TurnLatency[]
      log: string[]
      stats: () => ReturnType<typeof latencyStats>
    }
  }
}

/**
 * Conversation mode for one chat: mic → engine (VAD, STT) → loop → chat send;
 * chat replies → loop → engine TTS → headphones. The mic is open exactly while
 * a session exists.
 */
export class VoiceSession {
  private stopped = false
  private readonly cleanups: Array<() => void> = []
  private status: VoiceSessionStatus = { phase: 'starting', error: null, loop: null, engine: null }

  constructor(private readonly deps: VoiceSessionDeps) {
    window.__slayzoneVoice = { samples, log, stats: () => latencyStats(samples) }
    void this.start().catch((err: unknown) =>
      this.fail(err instanceof Error ? err.message : String(err))
    )
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup()
      } catch {
        // best effort: keep closing the rest
      }
    }
  }

  private async start(): Promise<void> {
    const engine = await VoiceEngineClient.open()
    if (!engine) return this.fail('Voice mode needs the SlayZone desktop app.')
    if (this.stopped) return engine.close()
    this.cleanups.push(() => engine.close())

    const { tts, elevenLabsVoiceId } = this.deps.settings
    const started = await engine.start(
      tts,
      tts === 'elevenlabs' ? elevenLabsVoiceId || undefined : undefined
    )
    if (this.stopped) return
    if (!started.ok) return this.fail(started.message)

    // The worklet's health report: logged when it starts and whenever it is unhealthy.
    const mic = await openMic(engine, (stats) => {
      const s = stats as { calls?: number; hasInput?: boolean; attached?: boolean }
      if (s.calls === 1 || !s.hasInput || !s.attached) note(`mic ${JSON.stringify(stats)}`)
    })
    if (this.stopped) return mic.close()
    this.cleanups.push(mic.close)

    const sink = new WebAudioSink()
    this.cleanups.push(() => sink.close())
    const loop = new VoiceLoop({
      config: this.deps.settings,
      now: voiceNow,
      newId: () => crypto.randomUUID(),
      tts: engine.tts,
      sink,
      sendTurn: (text, id) => {
        note(`send ${id} ${JSON.stringify(text.slice(-120))}`)
        return this.deps.sendTurn(text, id)
      },
      onStatus: (s) => this.update({ loop: s }),
      onLatency: (sample) => {
        samples.push(sample)
        console.info('[voice] turn latency (ms)', sample, latencyStats(samples))
      },
      onError: (message) => {
        note(`error ${message}`)
        this.update({ error: message })
      }
    })
    this.cleanups.push(() => loop.dispose())
    let ticks = 0
    this.cleanups.push(
      engine.onEvent((m) => {
        if (m.type !== 'tick') note(`engine ${JSON.stringify(m).slice(0, 200)}`)
        else if (++ticks % 100 === 1) note(`tick ${ticks} (mic audio reaching the engine)`)
        if (m.type === 'tick') loop.tick()
        else if (m.type === 'speech-start') loop.speechStarted()
        else if (m.type === 'speech-probe') loop.speechProbe(m.text)
        else if (m.type === 'speech-end') loop.speechEnded(m.at)
        else if (m.type === 'transcript') loop.transcript(m.text, m.at)
        else if (m.type === 'error') this.update({ error: m.message })
      })
    )
    this.cleanups.push(this.deps.subscribeEvents((e) => loop.agentEvent(e)))
    this.update({ phase: 'running', engine: started.info })
  }

  private fail(message: string): void {
    this.update({ phase: 'error', error: message })
    this.stop()
  }

  private update(patch: Partial<VoiceSessionStatus>): void {
    this.status = { ...this.status, ...patch }
    this.deps.onStatus(this.status)
  }
}

/** The mic, captured at 16 kHz on an AudioWorklet that posts straight to the engine. */
async function openMic(
  engine: VoiceEngineClient,
  onStats: (stats: unknown) => void
): Promise<{ close: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Headphones only: no echo to cancel, and AEC would color the VAD input.
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
  const ctx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE, latencyHint: 'interactive' })
  const close = (): void => {
    for (const track of stream.getTracks()) track.stop()
    void ctx.close()
  }
  try {
    await ctx.audioWorklet.addModule(captureWorkletUrl)
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'slayzone-mic-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit'
    })
    const audioPort = engine.takeAudioPort()
    if (!audioPort) throw new Error('Voice engine audio port already taken')
    node.port.onmessage = (e: MessageEvent) => onStats(e.data)
    node.port.postMessage({ type: 'engine-port', port: audioPort }, [audioPort])
    // Pulled by the graph through a muted gain: the worklet runs, nothing is heard.
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(node).connect(mute).connect(ctx.destination)
    if (ctx.state === 'suspended') await ctx.resume()
    return {
      close: () => {
        node.port.postMessage({ type: 'detach' })
        source.disconnect()
        close()
      }
    }
  } catch (err) {
    close()
    throw err
  }
}
