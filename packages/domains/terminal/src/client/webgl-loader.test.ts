/**
 * Lifecycle tests for loadWebglRenderer — verifies the WebGL renderer
 * load / guard / context-loss logic without a GPU or a real xterm instance.
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/webgl-loader.test.ts
 */
import type { WebglAddon } from '@xterm/addon-webgl'
import {
  loadWebglRenderer,
  correctAtlas,
  downgradeToDom,
  type DowngradeReason,
  type LoadWebglOptions
} from './webgl-loader'

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

/** Stub WebglAddon — records the lifecycle calls the loader makes. */
function makeStubAddon() {
  const calls = {
    contextLossHandler: null as null | (() => void),
    disposed: 0,
    clearedAtlas: 0
  }
  const addon = {
    onContextLoss(cb: () => void) {
      calls.contextLossHandler = cb
    },
    dispose() {
      calls.disposed++
    },
    clearTextureAtlas() {
      calls.clearedAtlas++
    }
  }
  return { addon: addon as unknown as WebglAddon, calls }
}

/** Stub terminal — records loadAddon / refresh. */
function makeStubTerminal() {
  const calls = { loadAddon: 0, refresh: 0, loadedAddon: null as unknown }
  const terminal: LoadWebglOptions['terminal'] = {
    rows: 24,
    loadAddon(addon: unknown) {
      calls.loadAddon++
      calls.loadedAddon = addon
    },
    refresh() {
      calls.refresh++
    }
  } as LoadWebglOptions['terminal']
  return { terminal, calls }
}

interface Harness {
  opts: LoadWebglOptions
  state: {
    aborted: boolean
    current: boolean
    webglDisabled: boolean
    activeAddon: WebglAddon | null
    createCalls: number
    onWebglDisabledCalls: number
    frames: Array<() => void>
    timers: Array<{ cb: () => void; ms: number }>
    downgrades: DowngradeReason[]
  }
  addonCalls: ReturnType<typeof makeStubAddon>['calls']
  termCalls: ReturnType<typeof makeStubTerminal>['calls']
  stubAddon: WebglAddon
  /** Run every callback the loader scheduled via requestFrame (simulates rAF firing). */
  flushFrames: () => void
  /** Run every callback the loader scheduled via requestTimeout (simulates setTimeout firing). */
  flushTimers: () => void
}

/** Build a loader-options harness with overridable behavior. */
function harness(over: Partial<{ createThrows: boolean }> = {}): Harness {
  const { addon, calls: addonCalls } = makeStubAddon()
  const { terminal, calls: termCalls } = makeStubTerminal()
  const state = {
    aborted: false,
    current: true,
    webglDisabled: false,
    activeAddon: null as WebglAddon | null,
    createCalls: 0,
    onWebglDisabledCalls: 0,
    frames: [] as Array<() => void>,
    timers: [] as Array<{ cb: () => void; ms: number }>,
    downgrades: [] as DowngradeReason[]
  }
  const opts: LoadWebglOptions = {
    terminal,
    createAddon: () => {
      state.createCalls++
      if (over.createThrows) throw new Error('WebGL unavailable')
      return addon
    },
    isAborted: () => state.aborted,
    isCurrentTerminal: () => state.current,
    isWebglDisabled: () => state.webglDisabled,
    onWebglDisabled: () => {
      state.onWebglDisabledCalls++
      state.webglDisabled = true
    },
    getActiveAddon: () => state.activeAddon,
    setActiveAddon: (a) => {
      state.activeAddon = a
    },
    requestFrame: (cb) => {
      state.frames.push(cb)
    },
    requestTimeout: (cb, ms) => {
      state.timers.push({ cb, ms })
    },
    onDowngrade: (reason) => {
      state.downgrades.push(reason)
    }
  }
  const flushFrames = (): void => {
    const pending = state.frames.splice(0)
    for (const cb of pending) cb()
  }
  const flushTimers = (): void => {
    const pending = state.timers.splice(0)
    for (const { cb } of pending) cb()
  }
  return { opts, state, addonCalls, termCalls, stubAddon: addon, flushFrames, flushTimers }
}

function run(): void {
  console.log('\nloadWebglRenderer')
  console.log('─'.repeat(40))

  test('happy path: constructs addon, registers context-loss, stores active', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    ok(h.state.createCalls === 1, 'createAddon called once')
    ok(h.termCalls.loadAddon === 1, 'loadAddon called')
    ok(h.termCalls.loadedAddon === h.stubAddon, 'the constructed addon was loaded')
    ok(h.state.activeAddon === h.stubAddon, 'addon stored as active')
    ok(h.addonCalls.contextLossHandler !== null, 'context-loss handler registered')
  })

  test('aborted: no addon constructed', () => {
    const h = harness()
    h.state.aborted = true
    loadWebglRenderer(h.opts)
    ok(h.state.createCalls === 0, 'createAddon not called')
  })

  test('webglDisabled latch: no addon constructed', () => {
    const h = harness()
    h.state.webglDisabled = true
    loadWebglRenderer(h.opts)
    ok(h.state.createCalls === 0, 'createAddon not called')
  })

  test('stale terminal: no addon constructed', () => {
    const h = harness()
    h.state.current = false
    loadWebglRenderer(h.opts)
    ok(h.state.createCalls === 0, 'createAddon not called')
  })

  test('addon already active: skips, no second addon constructed', () => {
    const h = harness()
    h.state.activeAddon = makeStubAddon().addon
    loadWebglRenderer(h.opts)
    ok(h.state.createCalls === 0, 'createAddon not called')
    ok(h.termCalls.loadAddon === 0, 'loadAddon not called')
  })

  test('construction throws: latches WebGL off, no loadAddon', () => {
    const h = harness({ createThrows: true })
    loadWebglRenderer(h.opts)
    ok(h.state.onWebglDisabledCalls === 1, 'onWebglDisabled called')
    ok(h.state.webglDisabled === true, 'webglDisabled latched true')
    ok(h.termCalls.loadAddon === 0, 'loadAddon not called')
  })

  test('cold-start correction: re-rasterizes + repaints on the frame then each straggler', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    ok(h.addonCalls.clearedAtlas === 0, 'nothing corrected synchronously')
    ok(h.termCalls.refresh === 0, 'screen not refreshed synchronously')
    h.flushFrames()
    ok(h.addonCalls.clearedAtlas === 1, 'atlas re-rasterized on the next frame')
    ok(h.termCalls.refresh === 1, 'screen repainted on the next frame')
    ok(
      h.state.timers.map((t) => t.ms).join(',') === '250,750',
      'straggler corrections scheduled at 250ms + 750ms'
    )
    h.flushTimers()
    ok(h.addonCalls.clearedAtlas === 3, 'atlas re-rasterized again on each straggler')
    ok(h.termCalls.refresh === 3, 'screen repainted again on each straggler')
  })

  test('cold-start correction skipped: terminal unmounted before correcting', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    h.state.aborted = true
    h.flushFrames()
    h.flushTimers()
    ok(h.addonCalls.clearedAtlas === 0, 'atlas not cleared after abort')
    ok(h.termCalls.refresh === 0, 'screen not refreshed after abort')
  })

  test('cold-start correction skipped: addon superseded before correcting', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    h.state.activeAddon = makeStubAddon().addon // a different addon won the slot
    h.flushFrames()
    h.flushTimers()
    ok(h.addonCalls.clearedAtlas === 0, 'atlas not cleared for superseded addon')
  })

  test('context loss: disposes addon, clears active ref, repaints, fires onDowngrade', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    ok(h.addonCalls.contextLossHandler !== null, 'context-loss handler registered')
    const refreshBefore = h.termCalls.refresh
    h.addonCalls.contextLossHandler!()
    ok(h.addonCalls.disposed === 1, 'addon disposed')
    ok(h.state.activeAddon === null, 'active addon ref cleared')
    ok(h.termCalls.refresh === refreshBefore + 1, 'screen repainted on context loss')
    ok(
      h.state.downgrades.length === 1 && h.state.downgrades[0] === 'context-loss',
      'onDowngrade fired with reason=context-loss'
    )
  })

  test('downgradeToDom: disposes, clears active, repaints, fires onDowngrade with reason', () => {
    const { addon, calls: addonCalls } = makeStubAddon()
    const { terminal, calls: termCalls } = makeStubTerminal()
    let active: WebglAddon | null = addon
    const downgrades: DowngradeReason[] = []
    downgradeToDom(
      addon,
      terminal,
      {
        setActiveAddon: (a) => {
          active = a
        },
        getActiveAddon: () => active,
        onDowngrade: (r) => downgrades.push(r),
        sessionId: 'test'
      },
      'canary'
    )
    ok(addonCalls.disposed === 1, 'addon disposed')
    ok(active === null, 'active addon cleared')
    ok(termCalls.refresh === 1, 'screen repainted')
    ok(downgrades.length === 1 && downgrades[0] === 'canary', 'onDowngrade fired with reason')
  })

  test('downgradeToDom: idempotent — second call against superseded addon is harmless', () => {
    const { addon, calls: addonCalls } = makeStubAddon()
    const { terminal } = makeStubTerminal()
    const newer = makeStubAddon().addon
    let active: WebglAddon | null = newer // newer addon already replaced the slot
    const downgrades: DowngradeReason[] = []
    downgradeToDom(
      addon,
      terminal,
      {
        setActiveAddon: (a) => {
          active = a
        },
        getActiveAddon: () => active,
        onDowngrade: (r) => downgrades.push(r),
        sessionId: 'test'
      },
      'frame-time'
    )
    ok(addonCalls.disposed === 1, 'old addon still disposed')
    ok(active === newer, 'newer addon slot untouched')
    ok(downgrades[0] === 'frame-time', 'onDowngrade still fires with caller-supplied reason')
  })

  test('downgradeToDom: swallows post-dispose addon throw', () => {
    const { terminal, calls: termCalls } = makeStubTerminal()
    const throwingAddon = {
      dispose() {
        throw new Error('already disposed')
      }
    } as unknown as WebglAddon
    let active: WebglAddon | null = throwingAddon
    const downgrades: DowngradeReason[] = []
    // Must not throw — a terminal disposed concurrently with a detector fire is normal.
    downgradeToDom(
      throwingAddon,
      terminal,
      {
        setActiveAddon: (a) => {
          active = a
        },
        getActiveAddon: () => active,
        onDowngrade: (r) => downgrades.push(r),
        sessionId: 'test'
      },
      'manual'
    )
    ok(active === null, 'active addon ref still cleared after throw')
    ok(termCalls.refresh === 1, 'refresh still attempted after dispose throw')
    ok(downgrades[0] === 'manual', 'onDowngrade still fires after dispose throw')
  })

  test('correctAtlas: re-rasterizes the atlas and repaints every visible row', () => {
    const { addon, calls: addonCalls } = makeStubAddon()
    const { terminal, calls: termCalls } = makeStubTerminal()
    correctAtlas(addon, terminal)
    ok(addonCalls.clearedAtlas === 1, 'atlas re-rasterized once')
    ok(termCalls.refresh === 1, 'screen repainted once')
  })

  test('correctAtlas: swallows a post-dispose throw', () => {
    const { terminal, calls: termCalls } = makeStubTerminal()
    const throwingAddon = {
      clearTextureAtlas() {
        throw new Error('addon disposed')
      }
    } as unknown as WebglAddon
    // Must not throw out — a terminal disposed between fit and correction is normal.
    correctAtlas(throwingAddon, terminal)
    ok(termCalls.refresh === 0, 'refresh not reached after the throw')
  })

  console.log('─'.repeat(40))
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
