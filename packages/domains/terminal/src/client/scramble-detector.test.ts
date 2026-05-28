/**
 * Unit tests for the WebGL renderer scramble detectors —
 * verifies frame-time threshold + WebGL-canvas scramble probe lifecycle
 * without a GPU or a real xterm instance.
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/scramble-detector.test.ts
 */
import type { WebglAddon } from '@xterm/addon-webgl'
import {
  monitorFrameTime,
  createScrambleProbe,
  type FrameTimeMonitorOptions,
  type PixelSampler,
  type ScrambleProbeOptions,
  type ScrambleProbeTerminal
} from './scramble-detector'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

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

function runFrameTimeTests(): void {
  console.log('\nmonitorFrameTime')
  console.log('─'.repeat(40))

  function ftHarness(opts: {
    deltas: number[]
    sampleCount?: number
    thresholdMs?: number
  }): {
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
    ok(h.state.downgrades.length === 0, 'no downgrade for healthy frame time')
    ok(h.addonCalls.disposed === 0, 'addon not disposed')
  })

  test('avg over threshold: fires downgrade with reason=frame-time', () => {
    const h = ftHarness({ deltas: [100, 100, 100, 100, 100], sampleCount: 5, thresholdMs: 50 })
    h.flushFrames()
    ok(h.state.downgrades.length === 1, 'one downgrade fired')
    ok(h.state.downgrades[0] === 'frame-time', 'reason is frame-time')
    ok(h.addonCalls.disposed === 1, 'addon disposed')
  })

  test('avg exactly at threshold: no fire (strict >)', () => {
    const h = ftHarness({ deltas: [50, 50, 50, 50, 50], sampleCount: 5, thresholdMs: 50 })
    h.flushFrames()
    ok(h.state.downgrades.length === 0, 'no downgrade at exact threshold')
  })

  test('aborted mid-sampling: no fire', () => {
    const h = ftHarness({ deltas: [100, 100], sampleCount: 5, thresholdMs: 50 })
    h.flushFrames()
    h.state.aborted = true
    h.flushFrames()
    ok(h.state.downgrades.length === 0, 'no downgrade after abort')
  })

  test('isCurrent false: stops sampling, no fire', () => {
    const h = ftHarness({ deltas: [100, 100, 100, 100, 100], sampleCount: 5, thresholdMs: 50 })
    h.state.current = false
    h.flushFrames()
    ok(h.state.downgrades.length === 0, 'no downgrade when isCurrent false')
  })

  test('explicit stop(): cancels pending frame, no fire', () => {
    const h = ftHarness({ deltas: [100], sampleCount: 5, thresholdMs: 50 })
    h.stop()
    h.flushFrames()
    ok(h.state.downgrades.length === 0, 'no downgrade after explicit stop')
  })
}

// ---------------------------------------------------------------------------
// createScrambleProbe — Signal C
// ---------------------------------------------------------------------------

function runScrambleProbeTests(): void {
  console.log('\ncreateScrambleProbe')
  console.log('─'.repeat(40))

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
    ok(h.downgrades.length === 0, 'no fire on first probe')
    ok(h.addonCalls.disposed === 0, 'addon not disposed')
  })

  test('stable buffer + stable pixels: no fire across many probes', () => {
    const h = spHarness()
    h.flushIntervals() // baseline
    h.flushIntervals()
    h.flushIntervals()
    h.flushIntervals()
    h.flushIntervals()
    ok(h.downgrades.length === 0, 'no fire when both buffer + pixels stable')
  })

  test('same buffer + drifted pixels for N=3: fires downgrade with reason=canary', () => {
    const h = spHarness({ driftDebounce: 3 })
    h.flushIntervals() // baseline
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals() // drift #1
    h.flushIntervals() // drift #2
    ok(h.downgrades.length === 0, 'still under debounce after 2 drifts')
    h.flushIntervals() // drift #3 → fire
    ok(h.downgrades.length === 1, 'one downgrade after 3 drifts')
    ok(h.downgrades[0] === 'canary', 'reason is canary')
    ok(h.addonCalls.disposed === 1, 'addon disposed')
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
    ok(h.downgrades.length === 0, 'content change suppressed false-positive scramble')
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
    ok(h.downgrades.length === 0, 'no fire — recovery between drifts broke the streak')
  })

  test('sampler not ready: probe is silent', () => {
    const h = spHarness({ driftDebounce: 1 })
    h.samp.setReady(false)
    h.flushIntervals()
    h.flushIntervals()
    ok(h.downgrades.length === 0, 'no fire when sampler not ready')
  })

  test('sampler returns null (context lost): probe is silent', () => {
    const h = spHarness({ driftDebounce: 1 })
    h.samp.setBytes(null)
    h.flushIntervals()
    h.flushIntervals()
    ok(h.downgrades.length === 0, 'no fire when sample returns null')
  })

  test('aborted: probe is a no-op', () => {
    const h = spHarness({ driftDebounce: 3 })
    h.flushIntervals() // baseline
    h.state.aborted = true
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals()
    h.flushIntervals()
    h.flushIntervals()
    ok(h.downgrades.length === 0, 'no fire when aborted')
  })

  test('addon superseded: probe is a no-op', () => {
    const h = spHarness({ driftDebounce: 3 })
    h.flushIntervals() // baseline
    h.state.activeAddon = makeStubAddon().addon
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals()
    h.flushIntervals()
    h.flushIntervals()
    ok(h.downgrades.length === 0, 'no fire when addon superseded')
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
    ok(h.downgrades.length === 0, 'manual rebaseline suppressed false-positive')
  })

  test('dispose(): no further fires, interval cleared', () => {
    const h = spHarness({ driftDebounce: 1 })
    h.flushIntervals() // baseline
    h.probe.dispose()
    h.samp.setBytes(new Uint8Array([99, 99, 99, 99, 99, 99, 99, 99]))
    h.flushIntervals()
    ok(h.downgrades.length === 0, 'no fire after dispose')
  })

  test('dispose() is idempotent', () => {
    const h = spHarness()
    h.probe.dispose()
    h.probe.dispose() // must not throw
    ok(true, 'second dispose did not throw')
  })
}

function run(): void {
  runFrameTimeTests()
  runScrambleProbeTests()
  console.log('\n' + '─'.repeat(40))
  console.log(`${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
