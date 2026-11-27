// Mic capture, on the audio rendering thread: mono frames are batched and posted
// straight to the voice engine over the audio MessagePort the page hands in. The
// UI thread never touches PCM. Runs in an AudioContext at 16 kHz (the engine's rate).

declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

/** ~32 ms at 16 kHz: one Silero window per post. */
const BATCH = 512

class MicCapture extends AudioWorkletProcessor {
  private engine: MessagePort | null = null
  private buf = new Float32Array(BATCH)
  private fill = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; port?: MessagePort }
      if (data?.type === 'engine-port' && data.port) this.engine = data.port
      if (data?.type === 'detach') {
        this.engine?.close()
        this.engine = null
      }
    }
  }

  private processed = 0

  process(inputs: Float32Array[][]): boolean {
    // Health report for the page (~every 2 s of audio): is the graph pulling us?
    if (++this.processed % 250 === 1) {
      this.port.postMessage({
        type: 'stats',
        calls: this.processed,
        hasInput: !!inputs[0]?.[0],
        attached: this.engine !== null
      })
    }
    const channel = inputs[0]?.[0]
    if (!channel || !this.engine) return true
    let i = 0
    while (i < channel.length) {
      const n = Math.min(BATCH - this.fill, channel.length - i)
      this.buf.set(channel.subarray(i, i + n), this.fill)
      this.fill += n
      i += n
      if (this.fill === BATCH) {
        // Cloned, not transferred: a transfer list does not survive the hop to
        // Electron's MessagePortMain (the engine then gets an empty object).
        this.engine.postMessage(this.buf)
        this.fill = 0
      }
    }
    return true
  }
}

registerProcessor('slayzone-mic-capture', MicCapture)
