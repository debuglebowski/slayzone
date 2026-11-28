/**
 * The desktop voice engine (a utility process running the local providers) and
 * the renderer talk over two MessagePorts:
 *   - audio:   mic PCM frames, posted straight from the capture AudioWorklet
 *              (16 kHz mono Float32Array, transferred) — never via the UI thread;
 *   - control: everything else, below.
 * Times are epoch ms with sub-ms precision (`performance.timeOrigin + now()`),
 * comparable across the two processes.
 */

import type { TtsChoice } from './tts-catalog'

export const VOICE_SAMPLE_RATE = 16000

/** Mic samples between two `tick`s (50 ms). */
export const VOICE_TICK_SAMPLES = 800

export interface VoiceEngineInfo {
  stt: string
  tts: string
  vad: string
  ttsSampleRate: number
  loadMs: number
}

export type VoiceClientMessage =
  /** Load the models (VAD, STT, this voice) and start listening. */
  | { type: 'start'; tts: TtsChoice; ttsVoice?: string }
  | { type: 'synthesize'; id: number; text: string }
  | { type: 'cancel-synthesis' }
  | { type: 'stop' }

export type VoiceEngineMessage =
  | { type: 'ready'; info: VoiceEngineInfo }
  | { type: 'models-missing'; dir: string; missing: string[] }
  | { type: 'error'; message: string }
  /**
   * Every ~50 ms of mic audio received: the voice loop's clock. Audio-driven, so it
   * keeps time while the window is hidden (renderer timers are throttled then;
   * port messages are not) — hands-free use is mostly with the app in the back.
   */
  | { type: 'tick' }
  | { type: 'speech-start'; at: number }
  /** Early words of speech still going on (barge-in: words or a cough?). */
  | { type: 'speech-probe'; text: string; at: number }
  | { type: 'speech-end'; segmentId: number; at: number }
  | { type: 'transcript'; segmentId: number; text: string; at: number; sttMs: number }
  | { type: 'synthesized'; id: number; pcm: Float32Array; sampleRate: number; ms: number }
  | { type: 'synthesis-failed'; id: number; message: string }

export function voiceNow(): number {
  return performance.timeOrigin + performance.now()
}
