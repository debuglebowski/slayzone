/**
 * Detection signals for WebGL terminal renderer health.
 *
 * Each detector watches a different failure mode and routes its decision
 * through the shared `downgradeToDom` helper in webgl-loader.ts so the
 * disposal sequence stays identical regardless of who fired:
 *
 *   monitorFrameTime    — Signal B. Catches "WebGL constructs but renders very
 *                         slowly" (bad drivers, software fallback, virtualized
 *                         GPU). Mirrors VS Code's `gpuAcceleration: auto`.
 *
 *   createScrambleProbe — Signal C. Catches glyph scramble at the *render-
 *                         output* layer: samples the WebGL canvas's pixels via
 *                         `gl.readPixels`, tied to the xterm buffer content as
 *                         a rebaseline signal. When the buffer is unchanged
 *                         but the rendered pixels diverge from the baseline,
 *                         the GPU is painting from a corrupted state — that is
 *                         scramble.
 *
 *                         Requires `preserveDrawingBuffer: true` on the
 *                         `WebglAddon` so `readPixels` returns valid data
 *                         outside the rAF that drew the frame. Pays a small
 *                         GPU memory + perf cost; the trade is necessary —
 *                         the CPU-side atlas canvas (an earlier attempt)
 *                         does not reflect GPU-side eviction.
 *
 * Signal A (context-loss) is wired directly inside `loadWebglRenderer` via
 * the `onContextLoss` xterm exposes, so it doesn't need a helper here.
 */
import type { Terminal as XTerm } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'
import { downgradeToDom, type DowngradeReason } from './webgl-loader'

// ---------------------------------------------------------------------------
// Signal B — frame-time heartbeat at startup
// ---------------------------------------------------------------------------

export interface FrameTimeMonitorOptions {
  /** The addon to monitor (and downgrade if the threshold is breached). */
  addon: WebglAddon
  /** The xterm instance — passed to `downgradeToDom` for the post-downgrade refresh. */
  terminal: Pick<XTerm, 'refresh' | 'rows'>
  getActiveAddon: () => WebglAddon | null
  setActiveAddon: (addon: WebglAddon | null) => void
  onDowngrade?: (reason: DowngradeReason) => void
  isAborted: () => boolean
  /** True while this addon is still the live one — stops sampling otherwise. */
  isCurrent: () => boolean
  /** Average rAF delta (ms) above which the renderer is flagged. Default 50 (matches VS Code). */
  thresholdMs?: number
  /** How many rAF deltas to average. Default 20. */
  sampleCount?: number
  /** Inject for tests; production uses `window.requestAnimationFrame`. */
  requestFrame?: (cb: () => void) => number
  /** Inject for tests; production uses `window.cancelAnimationFrame`. */
  cancelFrame?: (id: number) => void
  /** Inject for tests; production uses `performance.now`. */
  now?: () => number
  sessionId?: string
}

/**
 * Sample the first `sampleCount` rAF deltas after the WebGL addon attaches.
 * If the average exceeds `thresholdMs`, downgrade to the DOM renderer.
 *
 * Catches the "WebGL constructs but renders very slowly" failure class —
 * bad GPU drivers, SwiftShader software fallback, virtualized GPU. xterm
 * surfaces no event for this; we have to measure paint cadence ourselves.
 *
 * Returns a cleanup function that cancels any pending sample frame.
 */
export function monitorFrameTime(opts: FrameTimeMonitorOptions): () => void {
  const thresholdMs = opts.thresholdMs ?? 50
  const sampleCount = opts.sampleCount ?? 20
  const requestFrame =
    opts.requestFrame ?? ((cb: () => void): number => window.requestAnimationFrame(cb))
  const cancelFrame =
    opts.cancelFrame ?? ((id: number): void => window.cancelAnimationFrame(id))
  const now = opts.now ?? ((): number => performance.now())

  const samples: number[] = []
  let last = now()
  let frameId: number | null = null
  let cancelled = false

  const stop = (): void => {
    cancelled = true
    if (frameId !== null) {
      cancelFrame(frameId)
      frameId = null
    }
  }

  const tick = (): void => {
    frameId = null
    if (cancelled || opts.isAborted() || !opts.isCurrent()) return
    if (opts.getActiveAddon() !== opts.addon) {
      // Addon was superseded (e.g. by a retry); stop sampling against a dead handle.
      cancelled = true
      return
    }
    const t = now()
    samples.push(t - last)
    last = t
    if (samples.length < sampleCount) {
      frameId = requestFrame(tick)
      return
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length
    if (avg > thresholdMs) {
      console.warn(
        `[terminal] frame-time avg ${avg.toFixed(1)}ms > ${thresholdMs}ms — downgrading to DOM renderer`
      )
      downgradeToDom(
        opts.addon,
        opts.terminal,
        {
          setActiveAddon: opts.setActiveAddon,
          getActiveAddon: opts.getActiveAddon,
          onDowngrade: opts.onDowngrade,
          sessionId: opts.sessionId
        },
        'frame-time'
      )
    }
  }

  frameId = requestFrame(tick)
  return stop
}

// ---------------------------------------------------------------------------
// Signal C — WebGL-canvas scramble probe
// ---------------------------------------------------------------------------

/**
 * Minimal terminal surface the probe touches: the buffer (for the rebaseline
 * signal — buffer-content hash) + refresh/rows (for the downgrade repaint).
 *
 * Defined as an interface so tests can supply a stub without depending on
 * the full xterm.js public surface.
 */
export interface ScrambleProbeTerminal {
  rows: number
  refresh(start: number, end: number): void
  buffer: {
    active: {
      viewportY: number
      getLine(idx: number): { translateToString(trim?: boolean): string } | undefined
    }
  }
  /** Container element xterm renders into. The probe queries it for the WebGL canvas. */
  element?: HTMLElement | null
}

/**
 * Source of pixels for the scramble check. Production resolves this from
 * `terminal.element.querySelector('canvas')`; tests inject a stub returning a
 * pre-canned byte array so they don't need WebGL.
 */
export interface PixelSampler {
  /** True once the underlying GL context exists and has non-zero dimensions. */
  isReady(): boolean
  /**
   * Sample a small fixed region of the rendered output. Returns null if the
   * GL context is lost / canvas detached / read fails — probe stays silent
   * rather than firing a false-positive downgrade.
   */
  sample(): Uint8Array | null
}

export interface ScrambleProbeOptions {
  addon: WebglAddon
  terminal: ScrambleProbeTerminal
  getActiveAddon: () => WebglAddon | null
  setActiveAddon: (addon: WebglAddon | null) => void
  onDowngrade?: (reason: DowngradeReason) => void
  isAborted: () => boolean
  isCurrent: () => boolean
  /** Periodic probe interval (ms). Default 5000. */
  intervalMs?: number
  /** Consecutive drift checks before downgrade. Default 3 (debounces edge timing). */
  driftDebounce?: number
  /** Hash stride over the pixel sample (every Nth pixel). Default 4. */
  stride?: number
  /**
   * Build the pixel sampler. Production locates the WebGL canvas under
   * `terminal.element` and uses `gl.readPixels`; tests supply a stub.
   */
  createSampler?: (terminal: ScrambleProbeTerminal) => PixelSampler
  /** Inject for tests; production uses `window.setInterval`. */
  setInterval?: (cb: () => void, ms: number) => number
  clearInterval?: (id: number) => void
  sessionId?: string
}

export interface ScrambleProbe {
  /** Force a re-baseline on the next probe (e.g. after a legitimate atlas correct). */
  rebaseline: () => void
  /** Run a probe check now (caller hook for focus / visibility events). */
  probe: () => void
  /** Cleanup interval + sampler. Safe to call multiple times. */
  dispose: () => void
}

/** FNV-1a 32-bit over the byte array with a configurable byte stride. */
function fnv1a(data: Uint8Array, stride: number): number {
  let hash = 0x811c9dc5
  const step = Math.max(1, stride)
  for (let i = 0; i < data.length; i += step) {
    hash ^= data[i]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Hash of the xterm buffer's *visible* rows by translating each line. Drives
 * the rebaseline signal: when this hash changes between probes we know
 * legitimate content moved, so the pixel hash *must* change too — re-capture
 * the baseline rather than flag drift.
 */
function bufferHash(terminal: ScrambleProbeTerminal): number {
  let h = 0x811c9dc5
  const buf = terminal.buffer.active
  for (let r = 0; r < terminal.rows; r++) {
    const line = buf.getLine(buf.viewportY + r)
    if (!line) continue
    const s = line.translateToString(true)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) & 0xff
      h = Math.imul(h, 0x01000193)
    }
    // Row delimiter so two single-row buffers with the same chars on
    // different rows don't collide.
    h ^= 0x0a
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Locate the WebGL render canvas inside an xterm container and return a
 * sampler bound to its GL context. The xterm public API does not expose the
 * canvas reference directly, but the DOM under `terminal.element` only
 * holds one canvas that responds to `getContext('webgl2'|'webgl')` — the
 * renderer's own.
 */
function defaultCreateSampler(terminal: ScrambleProbeTerminal): PixelSampler {
  const SAMPLE_W = 64
  const SAMPLE_H = 16

  let canvas: HTMLCanvasElement | null = null
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null

  const find = (): void => {
    if (canvas && gl) return
    const root = terminal.element
    if (!root) return
    const candidates = Array.from(root.querySelectorAll('canvas')) as HTMLCanvasElement[]
    for (const c of candidates) {
      try {
        const ctx2 = c.getContext('webgl2') as WebGL2RenderingContext | null
        if (ctx2) {
          canvas = c
          gl = ctx2
          return
        }
        const ctx1 = c.getContext('webgl') as WebGLRenderingContext | null
        if (ctx1) {
          canvas = c
          gl = ctx1
          return
        }
      } catch {
        /* getContext can throw on cross-context confusion; try the next */
      }
    }
  }

  return {
    isReady(): boolean {
      find()
      if (!canvas || !gl) return false
      if (canvas.width === 0 || canvas.height === 0) return false
      if (gl.isContextLost()) return false
      return true
    },
    sample(): Uint8Array | null {
      find()
      if (!canvas || !gl) return null
      if (gl.isContextLost()) return null
      const w = Math.min(SAMPLE_W, canvas.width)
      const h = Math.min(SAMPLE_H, canvas.height)
      if (w === 0 || h === 0) return null
      const data = new Uint8Array(w * h * 4)
      try {
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data)
      } catch {
        return null
      }
      return data
    }
  }
}

/**
 * Sample the WebGL renderer's *output* canvas and flag drift while the xterm
 * buffer content is unchanged.
 *
 * Invariants:
 *   1. Same buffer content ⇒ rendered pixels at the sampled region MUST hash
 *      to the same value. Deviation = the GPU painted from a corrupted state
 *      = scramble.
 *   2. Different buffer content ⇒ pixel hash will differ for legitimate
 *      reasons (new glyphs rasterized, cursor moved, scroll). The buffer
 *      hash is the rebaseline signal: we silently re-capture instead of
 *      flagging drift.
 *
 * Requires `preserveDrawingBuffer: true` on the `WebglAddon` so `readPixels`
 * returns valid data outside the rAF that drew the frame. Without it,
 * compositing clears the back buffer between rAFs and reads return zeros.
 *
 * False-positive avoidance: a single drift bumps a counter; only after
 * `driftDebounce` consecutive drifts (default 3 × 5s = 15s of sustained
 * drift) does the downgrade fire. A matching probe in between resets the
 * counter. Combined with the buffer-hash rebaseline this stays quiet during
 * normal use and only fires on actual rendered-output corruption.
 */
export function createScrambleProbe(opts: ScrambleProbeOptions): ScrambleProbe {
  const intervalMs = opts.intervalMs ?? 5000
  const driftDebounce = opts.driftDebounce ?? 3
  const stride = opts.stride ?? 4
  // WebGL atlas drift probe; sister system to Terminal.tsx atlas-correction.
  // Hidden-window throttling is handled by the caller via `opts.isCurrent()` /
  // `opts.isAborted()` checks inside the callback.
  // eslint-disable-next-line no-restricted-syntax
  const setInt = opts.setInterval ?? ((cb: () => void, ms: number): number => window.setInterval(cb, ms))
  const clearInt = opts.clearInterval ?? ((id: number): void => window.clearInterval(id))
  const sampler = (opts.createSampler ?? defaultCreateSampler)(opts.terminal)

  let baselineBufferHash = 0
  let baselinePixelHash = 0
  let hasBaseline = false
  let driftCount = 0
  let disposed = false

  const probe = (): void => {
    if (disposed || opts.isAborted() || !opts.isCurrent()) return
    if (opts.getActiveAddon() !== opts.addon) return
    if (!sampler.isReady()) return

    const currentPixels = sampler.sample()
    if (currentPixels === null) return

    const currentBufHash = bufferHash(opts.terminal)
    const currentPixelHash = fnv1a(currentPixels, stride)

    if (!hasBaseline || currentBufHash !== baselineBufferHash) {
      // First probe OR buffer content changed since the baseline. The pixel
      // hash will of course differ — silently re-anchor to the new content.
      baselineBufferHash = currentBufHash
      baselinePixelHash = currentPixelHash
      hasBaseline = true
      driftCount = 0
      return
    }

    if (currentPixelHash !== baselinePixelHash) {
      driftCount++
      if (driftCount >= driftDebounce) {
        console.warn(
          `[terminal] scramble probe drift across ${driftCount} probes — downgrading to DOM renderer`
        )
        downgradeToDom(
          opts.addon,
          opts.terminal,
          {
            setActiveAddon: opts.setActiveAddon,
            getActiveAddon: opts.getActiveAddon,
            onDowngrade: opts.onDowngrade,
            sessionId: opts.sessionId
          },
          'canary'
        )
      }
    } else {
      driftCount = 0
    }
  }

  const rebaseline = (): void => {
    hasBaseline = false
    driftCount = 0
  }

  const intervalId = setInt(probe, intervalMs)

  return {
    rebaseline,
    probe,
    dispose: (): void => {
      if (disposed) return
      disposed = true
      clearInt(intervalId)
    }
  }
}
