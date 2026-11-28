import type { AudioSink, PcmAudio } from '../shared'

/**
 * Speech playback on Web Audio (headphones: no echo handling). Scheduling only on
 * the UI thread — the audio itself renders on the audio thread.
 */
export class WebAudioSink implements AudioSink {
  private readonly ctx = new AudioContext({ latencyHint: 'interactive' })
  /** Speech goes through this: ducked while a sound may be the user cutting in. */
  private readonly volume = this.ctx.createGain()

  constructor() {
    this.volume.connect(this.ctx.destination)
  }
  private current: { source: AudioBufferSourceNode; resolve: (done: boolean) => void } | null = null

  play(audio: PcmAudio, onStart: () => void): Promise<boolean> {
    this.stop()
    return new Promise<boolean>((resolve) => {
      const buffer = this.ctx.createBuffer(1, audio.pcm.length, audio.sampleRate)
      buffer.copyToChannel(new Float32Array(audio.pcm), 0)
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      source.connect(this.volume)
      const entry = { source, resolve }
      this.current = entry
      source.onended = () => {
        if (this.current !== entry) return
        this.current = null
        resolve(true)
      }
      const begin = (): void => {
        if (this.current !== entry) return
        source.start()
        onStart()
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().then(begin, begin)
      else begin()
    })
  }

  stop(): void {
    const entry = this.current
    if (!entry) return
    this.current = null
    entry.source.onended = null
    try {
      entry.source.stop()
    } catch {
      // never started
    }
    entry.resolve(false)
  }

  duck(on: boolean): void {
    const t = this.ctx.currentTime
    this.volume.gain.cancelScheduledValues(t)
    this.volume.gain.setTargetAtTime(on ? 0.2 : 1, t, on ? 0.02 : 0.08)
  }

  tone(): void {
    const t = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.15, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
    osc.connect(gain).connect(this.ctx.destination)
    osc.start(t)
    osc.stop(t + 0.2)
  }

  close(): void {
    this.stop()
    void this.ctx.close()
  }
}
