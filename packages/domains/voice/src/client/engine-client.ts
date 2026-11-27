import { electronBootstrap } from '@slayzone/transport/client'
import { VOICE_HOST_PORTS_MESSAGE } from '@slayzone/platform/electron-bootstrap-contract'
import {
  abortError,
  type PcmAudio,
  type TtsChoice,
  type TtsProvider,
  type VoiceClientMessage,
  type VoiceEngineInfo,
  type VoiceEngineMessage
} from '../shared'

export type EngineStartResult =
  | { ok: true; info: VoiceEngineInfo }
  | { ok: false; reason: 'unavailable' | 'models-missing' | 'error'; message: string }

/** Ask this device's voice host for an engine session's two ports. */
function openPorts(
  timeoutMs = 10_000
): Promise<{ control: MessagePort; audio: MessagePort } | null> {
  const host = electronBootstrap.voiceHost()
  if (!host) return Promise.resolve(null)
  const requestId = crypto.randomUUID()
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { type?: string; requestId?: string }
      if (e.source !== window || data?.type !== VOICE_HOST_PORTS_MESSAGE) return
      if (data.requestId !== requestId) return
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      const [control, audio] = e.ports
      resolve(control && audio ? { control, audio } : null)
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      resolve(null)
    }, timeoutMs)
    window.addEventListener('message', onMessage)
    host.connect(requestId)
  })
}

/**
 * One session with the voice engine. Its `tts` is a `TtsProvider` backed by the
 * engine; speech-input events arrive through `onEvent`. The audio port goes to
 * the capture worklet (`takeAudioPort`), so mic PCM bypasses this thread.
 */
export class VoiceEngineClient {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (a: PcmAudio) => void; reject: (e: unknown) => void }
  >()
  private readonly listeners = new Set<(m: VoiceEngineMessage) => void>()
  private audioPort: MessagePort | null

  private constructor(
    private readonly control: MessagePort,
    audio: MessagePort
  ) {
    this.audioPort = audio
    control.onmessage = (e: MessageEvent) => this.onMessage(e.data as VoiceEngineMessage)
  }

  /** This device's stored cloud-voice keys: which are set (never the keys). */
  static keyStatus(): Promise<Record<string, boolean>> {
    return electronBootstrap.voiceHost()?.keyStatus() ?? Promise.resolve({})
  }

  /** Store (or clear, with '') this device's key for a cloud voice. */
  static setKey(provider: string, key: string): Promise<void> {
    const host = electronBootstrap.voiceHost()
    return host ? host.setKey(provider, key) : Promise.reject(new Error('Needs the desktop app'))
  }

  static async open(): Promise<VoiceEngineClient | null> {
    const ports = await openPorts()
    return ports ? new VoiceEngineClient(ports.control, ports.audio) : null
  }

  /** Load models (first session: seconds) and start listening. */
  start(tts: TtsChoice, ttsVoice?: string): Promise<EngineStartResult> {
    return new Promise((resolve) => {
      const off = this.onEvent((m) => {
        if (m.type === 'ready') {
          off()
          resolve({ ok: true, info: m.info })
        } else if (m.type === 'models-missing') {
          off()
          resolve({
            ok: false,
            reason: 'models-missing',
            message: `Voice models missing in ${m.dir}: ${m.missing.join(', ')}`
          })
        } else if (m.type === 'error') {
          off()
          resolve({ ok: false, reason: 'error', message: m.message })
        }
      })
      this.post({ type: 'start', tts, ttsVoice })
    })
  }

  /** The audio port, once: the capture worklet owns it from then on. */
  takeAudioPort(): MessagePort | null {
    const port = this.audioPort
    this.audioPort = null
    return port
  }

  onEvent(listener: (m: VoiceEngineMessage) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly tts: TtsProvider = {
    id: 'engine',
    synthesize: (text, signal) => {
      if (signal.aborted) return Promise.reject(abortError())
      const id = this.nextId++
      return new Promise<PcmAudio>((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        signal.addEventListener(
          'abort',
          () => {
            if (!this.pending.delete(id)) return
            this.post({ type: 'cancel-synthesis' })
            reject(abortError())
          },
          { once: true }
        )
        this.post({ type: 'synthesize', id, text })
      })
    }
  }

  close(): void {
    this.post({ type: 'stop' })
    for (const p of this.pending.values()) p.reject(abortError())
    this.pending.clear()
    this.listeners.clear()
    this.control.close()
    this.audioPort?.close()
  }

  private post(m: VoiceClientMessage): void {
    this.control.postMessage(m)
  }

  private onMessage(m: VoiceEngineMessage): void {
    if (m.type === 'synthesized') {
      const p = this.pending.get(m.id)
      if (p) {
        this.pending.delete(m.id)
        p.resolve({ pcm: m.pcm, sampleRate: m.sampleRate })
      }
    } else if (m.type === 'synthesis-failed') {
      const p = this.pending.get(m.id)
      if (p) {
        this.pending.delete(m.id)
        p.reject(new Error(m.message))
      }
    }
    for (const l of this.listeners) l(m)
  }
}
