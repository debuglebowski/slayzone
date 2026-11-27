import {
  isCloudTts,
  PARAKEET_TDT_V3,
  SILERO_VAD,
  SpeechInput,
  ttsEntry,
  VOICE_TICK_SAMPLES,
  voiceNow,
  type CloudTtsProvider,
  type TtsChoice,
  type TtsProvider,
  type VoiceClientMessage,
  type VoiceEngineInfo,
  type VoiceEngineMessage
} from '../shared'
import { createCloudTts } from './cloud-tts'
import {
  KokoroTts,
  missingModels,
  ParakeetStt,
  PocketTts,
  SileroVad,
  SupertonicTts
} from './sherpa-providers'

/**
 * The desktop voice engine: the local providers in a process of their own (an
 * Electron utility process), so model inference never runs on the main process
 * or a renderer. Each renderer that turns conversation mode on gets a session:
 * its own VAD state over two ports (audio in, control both ways); the models
 * are loaded once and shared.
 */

/** Electron's MessagePortMain, minimally (kept structural: no electron import here). */
export interface EnginePort {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  postMessage(message: unknown): void
  start(): void
  close(): void
}

/** `process.parentPort` of an Electron utility process. */
export interface EngineParentPort {
  on(event: 'message', listener: (e: { data: unknown; ports: EnginePort[] }) => void): unknown
}

export type EngineHostMessage = {
  type: 'connect'
  modelsDir: string
  /** Bring-your-own-key cloud voices: decrypted by main for this session only. */
  keys: Partial<Record<CloudTtsProvider, string>>
}

interface LoadedVoice {
  stt: ParakeetStt
  tts: TtsProvider & { readonly sampleRate: number }
  info: VoiceEngineInfo
}

/** Loaded once per engine, shared by sessions: STT, and each local voice used. */
let sttLoad: { dir: string; stt: Promise<ParakeetStt> } | null = null
const localTts = new Map<string, Promise<TtsProvider & { readonly sampleRate: number }>>()

function loadStt(modelsDir: string): Promise<ParakeetStt> {
  if (sttLoad?.dir !== modelsDir) {
    const stt = ParakeetStt.load(modelsDir)
    sttLoad = { dir: modelsDir, stt }
    // A failed load is retried by the next session.
    stt.catch(() => {
      if (sttLoad?.stt === stt) sttLoad = null
    })
  }
  return sttLoad.stt
}

function loadLocalTts(
  modelsDir: string,
  choice: Exclude<TtsChoice, CloudTtsProvider>
): Promise<TtsProvider & { readonly sampleRate: number }> {
  const key = `${modelsDir}\0${choice}`
  let tts = localTts.get(key)
  if (!tts) {
    tts =
      choice === 'kokoro'
        ? KokoroTts.load(modelsDir)
        : choice === 'supertonic'
          ? SupertonicTts.load(modelsDir)
          : PocketTts.load(modelsDir)
    localTts.set(key, tts)
    tts.catch(() => localTts.delete(key))
  }
  return tts
}

function loadVoice(
  modelsDir: string,
  choice: TtsChoice,
  ttsVoice: string | undefined,
  keys: EngineHostMessage['keys']
): Promise<LoadedVoice> {
  const startedAt = voiceNow()
  let tts: Promise<TtsProvider & { readonly sampleRate: number }>
  if (isCloudTts(choice)) {
    const key = keys[choice]
    if (!key) return Promise.reject(new Error('No API key set for ElevenLabs (voice settings)'))
    tts = Promise.resolve(createCloudTts(choice, key, ttsVoice))
  } else {
    tts = loadLocalTts(modelsDir, choice)
  }
  return Promise.all([loadStt(modelsDir), tts]).then(([stt, t]) => ({
    stt,
    tts: t,
    info: {
      stt: stt.id,
      tts: t.id,
      vad: 'silero-vad',
      ttsSampleRate: t.sampleRate,
      loadMs: Math.round(voiceNow() - startedAt)
    }
  }))
}

export function runVoiceEngineHost(parent: EngineParentPort): void {
  parent.on('message', (e) => {
    const msg = e.data as EngineHostMessage
    if (msg?.type !== 'connect') return
    const [control, audio] = e.ports
    if (!control || !audio) return
    openSession(msg.modelsDir, msg.keys ?? {}, control, audio)
  })
}

function openSession(
  modelsDir: string,
  keys: EngineHostMessage['keys'],
  control: EnginePort,
  audio: EnginePort
): void {
  const send = (m: VoiceEngineMessage): void => control.postMessage(m)
  let input: SpeechInput | null = null
  let loaded: LoadedVoice | null = null
  let synthAbort = new AbortController()
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    synthAbort.abort()
    input?.dispose()
    input = null
    control.close()
    audio.close()
  }

  const start = (choice: TtsChoice, ttsVoice: string | undefined): void => {
    const voice = ttsEntry(choice)
    const needed =
      voice.kind === 'local'
        ? [SILERO_VAD, PARAKEET_TDT_V3, voice.model]
        : [SILERO_VAD, PARAKEET_TDT_V3]
    const missing = missingModels(modelsDir, needed)
    if (missing.length > 0) {
      send({ type: 'models-missing', dir: modelsDir, missing })
      return
    }
    loadVoice(modelsDir, choice, ttsVoice, keys).then(
      (m) => {
        if (closed) return
        loaded = m
        const vad = new SileroVad(modelsDir)
        input = new SpeechInput(vad, m.stt, voiceNow, {
          speechStart: (at) => send({ type: 'speech-start', at }),
          speechProbe: (text, at) => send({ type: 'speech-probe', text, at }),
          speechEnd: (segmentId, at) => send({ type: 'speech-end', segmentId, at }),
          transcript: (segmentId, text, at, sttMs) =>
            send({ type: 'transcript', segmentId, text, at, sttMs }),
          error: (message) => send({ type: 'error', message })
        })
        send({ type: 'ready', info: m.info })
      },
      (err: unknown) =>
        send({
          type: 'error',
          message: `Voice failed to start: ${err instanceof Error ? err.message : String(err)}`
        })
    )
  }

  const synthesize = (id: number, text: string): void => {
    const m = loaded
    if (!m) {
      send({ type: 'synthesis-failed', id, message: 'Voice engine not ready' })
      return
    }
    const signal = synthAbort.signal
    const startedAt = voiceNow()
    m.tts.synthesize(text, signal).then(
      (out) => {
        if (signal.aborted || closed) return
        send({
          type: 'synthesized',
          id,
          pcm: out.pcm,
          sampleRate: out.sampleRate,
          ms: voiceNow() - startedAt
        })
      },
      (err: unknown) => {
        if (signal.aborted || closed) return
        send({ type: 'synthesis-failed', id, message: String(err) })
      }
    )
  }

  control.on('message', (e) => {
    const msg = e.data as VoiceClientMessage
    switch (msg?.type) {
      case 'start':
        start(msg.tts, msg.ttsVoice)
        return
      case 'synthesize':
        synthesize(msg.id, msg.text)
        return
      case 'cancel-synthesis':
        synthAbort.abort()
        synthAbort = new AbortController()
        return
      case 'stop':
        close()
        return
    }
  })
  let sinceTick = 0
  let reportedBadAudio = false
  audio.on('message', (e) => {
    const frame = asFloat32(e.data)
    if (!frame) {
      if (!reportedBadAudio) {
        reportedBadAudio = true
        const d = e.data as { constructor?: { name?: string } } | null
        const keys = d && typeof d === 'object' ? Object.keys(d).slice(0, 5).join(',') : ''
        send({
          type: 'error',
          message: `Unreadable mic audio: ${d?.constructor?.name ?? typeof d} {${keys}}`
        })
      }
      return
    }
    if (!input) return
    input.accept(frame)
    sinceTick += frame.length
    if (sinceTick >= VOICE_TICK_SAMPLES) {
      sinceTick = 0
      send({ type: 'tick' })
    }
  })
  control.on('close', close)
  audio.on('close', close)
  control.start()
  audio.start()
}

/** Mic PCM as it arrives over the port (a Float32Array; tolerate a bare buffer). */
function asFloat32(data: unknown): Float32Array | null {
  if (data instanceof Float32Array) return data
  if (data instanceof ArrayBuffer) return new Float32Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4))
  }
  return null
}
