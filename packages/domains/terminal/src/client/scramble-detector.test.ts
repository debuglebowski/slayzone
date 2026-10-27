/**
 * Unit tests for the WebGL renderer scramble detectors —
 * verifies frame-time threshold + WebGL-canvas scramble probe lifecycle
 * without a GPU or a real xterm instance.
 */
import { describe, expect, test } from 'vitest'
import type { WebglAddon } from '@xterm/addon-webgl'
import {
  monitorFrameTime,
  createScrambleProbe,
  type FrameTimeMonitorOptions,
  type PixelSampler,
  type ScrambleProbeOptions,
  type ScrambleProbeTerminal
} from './scramble-detector'

/** Stub xterm — records refresh calls + serves a swappable visible-buffer string. */
function makeStubTerminal(initialLines: string[] = ['']): {
  terminal: ScrambleProbeTerminal
  calls: { refresh: number }
  setLines: (lines: string[]) => void
} {
  let lines = initialLines
  const calls = { refresh: 0 }
  const terminal: ScrambleProbeTerminal = {
    rows: 0,
    refresh(): void {
      calls.refresh++
    },
    buffer: {
      active: {
        viewportY: 0,
        getLine(idx: number) {
          const s = lines[idx]
          if (s === undefined) return undefined
          return { translateToString: (): string => s }
        }
      }
    }
  }
  Object.defineProperty(terminal, 'rows', {
    get(): number {
      return lines.length
    }
  })
  return {
    terminal,
    calls,
    setLines: (l): void => {
      lines = l
    }
  }
}

/**
 * Stub `WebglAddon` — only the surface `downgradeToDom` touches (the four
 * xterm events the probe used to listen to are gone; this rebuild reads
 * pixels directly).
 */
function makeStubAddon(): {
  addon: WebglAddon
  calls: { disposed: number }
} {
  const calls = { disposed: 0 }
  const addon = {
    dispose(): void {
      calls.disposed++
    }
  }
  return { addon: addon as unknown as WebglAddon, calls }
}

/** Stub pixel sampler — returns a swappable byte array, with a ready flag. */
function makeStubSampler(initial: Uint8Array | null = new Uint8Array([1, 2, 3, 4])): {
  sampler: PixelSampler
  setBytes: (b: Uint8Array | null) => void
  setReady: (r: boolean) => void
} {
  let bytes: Uint8Array | null = initial
  let ready = true
  return {
    sampler: {
      isReady: (): boolean => ready,
      sample: (): Uint8Array | null => bytes
    },
    setBytes: (b): void => {
      bytes = b
    },
    setReady: (r): void => {
      ready = r
    }
  }
}

// ---------------------------------------------------------------------------
// monitorFrameTime — Signal B (unchanged from earlier rebuild)
// ---------------------------------------------------------------------------

describe('monitorFrameTime', () => {
  function ftHarness(opts: { deltas: number[]; sampleCount?: number; thresholdMs?: number }): {
    state: {
      aborted: boolean
      current: boolean
      activeAddon: WebglAddon | null
      downgrades: string[]
    }
    addon: WebglAddon
    addonCalls: ReturnType<typeof makeStubAddon>['calls']
    flushFrames: () => void
    stop: () => void
  } {
    const { addon, calls: addonCalls } = makeStubAddon()
    const { terminal } = makeStubTerminal([''])
    const state = {
      aborted: false,
      current: true,
      activeAddon: addon as WebglAddon | null,
      downgrades: [] as string[]
    }
    let clockMs = 0
    let nextFrameId = 1
    const queue: Array<{ id: number; cb: () => void }> = []

    const monitorOpts: FrameTimeMonitorOptions = {
      addon,
      terminal,
      getActiveAddon: () => state.activeAddon,
      setActiveAddon: (a) => {
        state.activeAddon = a
      },
      onDowngrade: (r) => state.downgrades.push(r),
      isAborted: () => state.aborted,
      isCurrent: () => state.current,
      thresholdMs: opts.thresholdMs ?? 50,
      sampleCount: opts.sampleCount ?? 5,
      now: () => clockMs,
      requestFrame: (cb) => {
        const id = nextFrameId++
        queue.push({ id, cb })
        return id
      },
      cancelFrame: (id) => {
        const idx = queue.findIndex((q) => q.id === id)
        if (idx >= 0) queue.splice(idx, 1)
      }
    }

    const stop = monitorFrameTime(monitorOpts)

    const flushFrames = (): void => {
      const deltas = [...opts.deltas]
      while (queue.length > 0 && deltas.length > 0) {
        const next = queue.shift()
        if (!next) break
        clockMs += deltas.shift()!
        next.cb()
      }
    }

    return { state, addon, addonCalls, flushFrames, stop }
  }

  test('avg under threshold: no downgrade fired', () => {
    const h = ftHarness({ deltas: [16, 16, 16, 16, 16], sampleCount: 5, thresholdMs: 50 })
    h.flushFrames()
    expect(h.state.downgrades, 'no downgrade for healthy frame time').toHaveLength(0)
    expect(h.addonCalls.disposed, 'addon not disposed').toBe(0)
  })

  test('avg over threshold: fires downgrade with reason=frame-time', () => {
    const h = ftHarness({ deltas: [100, 100, 100, 100, 100], sampleCount: 5, thresholdMs: 50 })
    h.flushFrames()
    expect(h.state.downgrades, 'one downgrade fired').toHaveLength(1)
    expect(h.state.downgrades[0], 'reason is frame-time').toBe('frame-time')
    expect(h.addonCalls.disposed, 'addon disposed').toBe(1)
  })

  test('avg exactly at threshold: no fire (strict >)', () => {
    const h = ftHarness({ deltas: [50, 50, 50, 50, 50], sampleCount: 5, thresholdMs: 50 })
    h.flushFrames()
    expect(h.state.downgrades, 'no downgrade at exact threshold').toHaveLength(0)
  })

  test('aborted mid-sampling: no fire', () => {
    const h = ftHarness({ deltas: [100, 100], sampleCount: 5, thresholdMs: 50 })
    h.flushFrames()
    h.state.aborted = true
    h.flushFrames()
    expect(h.state.downgrades, 'no downgrade after abort').toHaveLength(0)
  })

  test('isCurrent false: stops sampling, no fire', () => {
    const h = ftHarness({ deltas: [100, 100, 100, 100, 100], sampleCount: 5, thresholdMs: 50 })
    h.state.current = false
    h.flushFrames()
    expect(h.state.downgrades, 'no downgrade when isCurrent false').toHaveLength(0)
  })

  // Boot-jank regression: a busy renderer boot made every terminal's rAF deltas
  // >50ms, so every terminal downgraded to DOM for the whole session.
  function gatedHarness(opts: {
    deltas: number[]
    canSample?: () => boolean
    isJanky?: (from: number, to: number) => boolean
    maxFrames?: number
  }): {
    downgrades: string[]
    timers: Array<() => void>
    flush: () => void
  } {
    const { addon } = makeStubAddon()
    const { terminal } = makeStubTerminal([''])
    let active: WebglAddon | null = addon
    const downgrades: string[] = []
    let clockMs = 0
    const frames: Array<() => void> = []
    const timers: Array<() => void> = []
    monitorFrameTime({
      addon,
      terminal,
      getActiveAddon: () => active,
      setActiveAddon: (a) => {
        active = a
      },
      onDowngrade: (r) => downgrades.push(r),
      isAborted: () => false,
      isCurrent: () => true,
      thresholdMs: 50,
      sampleCount: 5,
      canSample: opts.canSample,
      isJanky: opts.isJanky,
      maxFrames: opts.maxFrames,
      now: () => clockMs,
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => {},
      setTimer: (cb) => timers.push(cb),
      clearTimer: () => {}
    })
    const flush = (): void => {
      const deltas = [...opts.deltas]
      while (frames.length > 0 && deltas.length > 0) {
        clockMs += deltas.shift()!
        frames.shift()!()
      }
    }
    return { downgrades, timers, flush }
  }

  test('canSample false (hidden / busy boot): no samples, no downgrade', () => {
    const h = gatedHarness({ deltas: Array(20).fill(200), canSample: () => false })
    h.flush()
    expect(h.downgrades, 'slow frames while not sampleable never downgrade').toHaveLength(0)
    expect(h.timers, 'waits on a timer (not rAF) to re-check').toHaveLength(1)
  })

  test('frames overlapping long tasks are discarded, not averaged', () => {
    // Every delta is 200ms but each overlaps a long task: thread jank, not GPU.
    const h = gatedHarness({
      deltas: Array(50).fill(200),
      isJanky: () => true,
      maxFrames: 40
    })
    h.flush()
    expect(h.downgrades, 'jank-only frames never downgrade').toHaveLength(0)
  })

  test('slow frames with no long task still downgrade (real slow GPU)', () => {
    const h = gatedHarness({ deltas: Array(10).fill(200), isJanky: () => false })
    h.flush()
    expect(h.downgrades, 'downgraded').toEqual(['frame-time'])
  })

  test('janky frames dropped, clean slow frames still judged', () => {
    // Alternate frames overlap a long task (keyed on the frame, as a real
    // long-task log is); the clean half alone is still slow.
    const h = gatedHarness({
      deltas: Array(30).fill(200),
      isJanky: (from) => Math.round(from / 200) % 2 === 0
    })
    h.flush()
    expect(h.downgrades, 'downgrade from the clean samples alone').toHaveLength(1)
  })

  test('explicit stop(): cancels pending frame, no fire', () => {
    const h = ftHarness({ deltas: [100], sampleCount: 5, thresholdMs: 50 })
    h.stop()
    h.flushFrames()
    expect(h.state.downgrades, 'no downgrade after explicit stop').toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// createScrambleProbe — Signal C
// ---------------------------------------------------------------------------

describe('createScrambleProbe', () => {
  function spHarness(over: Partial<ScrambleProbeOptions> = {}): {
    state: { aborted: boolean; current: boolean; activeAddon: WebglAddon | null }
    addon: WebglAddon
    addonCalls: ReturnType<typeof makeStubAddon>['calls']
    term: ReturnType<typeof makeStubTerminal>
    samp: ReturnType<typeof makeStubSampler>
    downgrades: string[]
    flushIntervals: () => void
    probe: ReturnType<typeof createScrambleProbe>
  } {
    const { addon, calls: addonCalls } = makeStubAddon()
    const term = makeStubTerminal(['hello world'])
    const samp = makeStubSampler(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    const state = {
      aborted: false,
      current: true,
      activeAddon: addon as WebglAddon | null
    }
    const downgrades: string[] = []
    const intervals: Array<{ cb: () => void; id: number }> = []
    let nextId = 1

    const probe = createScrambleProbe({
      addon,
      terminal: term.terminal,
      getActiveAddon: () => state.activeAddon,
      setActiveAddon: (a) => {
        state.activeAddon = a
      },
      onDowngrade: (r) => downgrades.push(r),
      isAborted: () => state.aborted,
      isCurrent: () => state.current,
      intervalMs: 5000,
      driftDebounce: 3,
      stride: 1,
      createSampler: () => samp.sampler,
      setInterval: (cb) => {
        const id = nextId++
        intervals.push({ cb, id })
        return id
      },
      clearInterval: (id) => {
        const idx = intervals.findIndex((i) => i.id === id)
        if (idx >= 0) intervals.splice(idx, 1)
      },
      ...over
    })

    const flushIntervals = (): void => {
      const snap = [...intervals]
      for (const { cb } of snap) cb()
    }

    return { state, addon, addonCalls, term, samp, downgrades, flushIntervals, probe }
  }

  test('first probe captures baseline silently (no fire)', () => {
    const h = spHarness()
    h.flushIntervals()
    expect(h.downgrades, 'no fire on first probe').toHaveLength(0)
    expect(h.addonCalls.disposed, 'addon not disposed').toBe(0)
  })

  test('stable buffer + stable pixels: no fire across many probes', () => {
    const h = spHarness()
    h.flushIntervals() // baseline
    h.flushIntervals()
    h.flushIntervals()
    h.flushIntervals()
    h.flushIntervals()
    expect(h.downgrades, 'no fire when both buffer + pixels stable').toHaveLength(0)
  })

  test('same buffer + drifted pixels for N=3: fires downgrade with reason=canary', () => {
    const h = spHarness({ driftDebounce: 3 })
    h.flushIntervals() // baseline
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals() // drift #1
    h.flushIntervals() // drift #2
    expect(h.downgrades, 'still under debounce after 2 drifts').toHaveLength(0)
    h.flushIntervals() // drift #3 → fire
    expect(h.downgrades, 'one downgrade after 3 drifts').toHaveLength(1)
    expect(h.downgrades[0], 'reason is canary').toBe('canary')
    expect(h.addonCalls.disposed, 'addon disposed').toBe(1)
  })

  test('buffer content changes mid-flight: silent rebaseline, no fire', () => {
    const h = spHarness({ driftDebounce: 3 })
    h.flushIntervals() // baseline on lines = ['hello world']
    h.term.setLines(['hello world', 'second row of content'])
    // Pixels would naturally change with new content — simulate that.
    h.samp.setBytes(new Uint8Array([50, 50, 50, 50, 50, 50, 50, 50]))
    h.flushIntervals() // sees new buffer hash → silent rebaseline
    h.flushIntervals() // matches new baseline
    h.flushIntervals() // matches new baseline
    h.flushIntervals() // matches new baseline
    expect(h.downgrades, 'content change suppressed false-positive scramble').toHaveLength(0)
  })

  test('matching probe between drifts: counter resets, no fire', () => {
    const h = spHarness({ driftDebounce: 3 })
    h.flushIntervals() // baseline on (buf=hello, pix=[1..8])
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals() // drift #1
    h.flushIntervals() // drift #2
    h.samp.setBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) // back to baseline pixels
    h.flushIntervals() // match → counter resets to 0
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals() // drift #1 again
    h.flushIntervals() // drift #2
    expect(h.downgrades, 'no fire — recovery between drifts broke the streak').toHaveLength(0)
  })

  test('sampler not ready: probe is silent', () => {
    const h = spHarness({ driftDebounce: 1 })
    h.samp.setReady(false)
    h.flushIntervals()
    h.flushIntervals()
    expect(h.downgrades, 'no fire when sampler not ready').toHaveLength(0)
  })

  test('sampler returns null (context lost): probe is silent', () => {
    const h = spHarness({ driftDebounce: 1 })
    h.samp.setBytes(null)
    h.flushIntervals()
    h.flushIntervals()
    expect(h.downgrades, 'no fire when sample returns null').toHaveLength(0)
  })

  test('aborted: probe is a no-op', () => {
    const h = spHarness({ driftDebounce: 3 })
    h.flushIntervals() // baseline
    h.state.aborted = true
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals()
    h.flushIntervals()
    h.flushIntervals()
    expect(h.downgrades, 'no fire when aborted').toHaveLength(0)
  })

  test('addon superseded: probe is a no-op', () => {
    const h = spHarness({ driftDebounce: 3 })
    h.flushIntervals() // baseline
    h.state.activeAddon = makeStubAddon().addon
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals()
    h.flushIntervals()
    h.flushIntervals()
    expect(h.downgrades, 'no fire when addon superseded').toHaveLength(0)
  })

  test('manual rebaseline(): recaptures silently on next probe', () => {
    const h = spHarness({ driftDebounce: 3 })
    h.flushIntervals() // baseline
    // Simulate a legitimate atlas correct that changes pixels but not buffer.
    h.samp.setBytes(new Uint8Array([77, 77, 77, 77, 77, 77, 77, 77]))
    h.probe.rebaseline()
    h.flushIntervals() // rebaselines silently
    h.flushIntervals() // matches new baseline
    h.flushIntervals() // matches new baseline
    expect(h.downgrades, 'manual rebaseline suppressed false-positive').toHaveLength(0)
  })

  test('dispose(): no further fires, interval cleared', () => {
    const h = spHarness({ driftDebounce: 1 })
    h.flushIntervals() // baseline
    h.probe.dispose()
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals()
    expect(h.downgrades, 'no fire after dispose').toHaveLength(0)
  })

  test('dispose() is idempotent', () => {
    const h = spHarness()
    h.probe.dispose()
    expect(() => h.probe.dispose(), 'second dispose did not throw').not.toThrow() // must not throw
  })
})
