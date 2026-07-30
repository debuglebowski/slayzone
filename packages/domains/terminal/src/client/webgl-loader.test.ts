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

  test('correctAtlas: the optional site label does not alter render behavior', () => {
    // `site` is diagnostics-only — it tags the `atlas-correct` diag event so a
    // correction's origin (startup / fit / heartbeat / reattach) is readable in
    // the ring buffer. It must never change what is painted. The label itself is
    // asserted live over CDP (`window.__slayzone_terminalDiag.dump()`): the diag
    // ring is module-level with a window-only reader, and this file's hoisted
    // static import loads that module before a stub `window` could be installed.
    const withSite = makeStubAddon()
    const withSiteTerm = makeStubTerminal()
    correctAtlas(withSite.addon, withSiteTerm.terminal, 'sess-1', 'heartbeat')
    ok(withSite.calls.clearedAtlas === 1, 'atlas re-rasterized once with a site label')
    ok(withSiteTerm.calls.refresh === 1, 'screen repainted once with a site label')

    const noSite = makeStubAddon()
    const noSiteTerm = makeStubTerminal()
    correctAtlas(noSite.addon, noSiteTerm.terminal, 'sess-1')
    ok(
      noSite.calls.clearedAtlas === withSite.calls.clearedAtlas &&
        noSiteTerm.calls.refresh === withSiteTerm.calls.refresh,
      'labelled and unlabelled corrections produce identical render calls'
    )
  })

  // ---------------------------------------------------------------------------
  // Shared-atlas sibling repair (P0c)
  //
  // `CharAtlasCache` is module-level: every terminal with matching font / size /
  // DPR / theme shares ONE `TextureAtlas`. Clearing it repacks the atlas for all
  // of them, but xterm only rebuilds a renderer's vertex data on that renderer's
  // next FRAME (`GlyphRenderer.beginFrame()` is reached only from
  // `WebglRenderer.renderRows`). So the repack must be followed by a frame on
  // EVERY sharing pane, not just the mutating one.
  //
  // Measured live (7 panes, 1 shared atlas, xterm 6.1.0-beta.292 /
  // addon-webgl 0.20.0-beta.291): after a single-pane correction, siblings sat
  // 52 repacks behind (`_lastSeenPageLayoutVersion` 94 vs `_pageLayoutVersion`
  // 146) painting 0% correct glyphs, and stayed there across multiple 30s
  // heartbeat ticks — the heartbeat is gated on `isActive`, so it repacks the
  // shared atlas while skipping the very panes it invalidates. One `refresh()`
  // per pane took all seven back to 100%.
  // ---------------------------------------------------------------------------
  console.log('\ncorrectAtlas — shared-atlas sibling repair')
  console.log('─'.repeat(40))

  test('broadcasts a frame to every sharing terminal, not just the mutating one', () => {
    const { addon, calls: addonCalls } = makeStubAddon()
    const mutating = makeStubTerminal()
    const siblingA = makeStubTerminal()
    const siblingB = makeStubTerminal()
    correctAtlas(addon, mutating.terminal, 'sess-1', 'heartbeat', () => [
      mutating.terminal,
      siblingA.terminal,
      siblingB.terminal
    ])
    ok(addonCalls.clearedAtlas === 1, 'atlas repacked exactly once')
    ok(siblingA.calls.refresh === 1, 'sibling A got a frame')
    ok(siblingB.calls.refresh === 1, 'sibling B got a frame')
    // The mutating pane must be painted exactly once even though it appears in
    // the registry — a double refresh would be wasted GPU work every heartbeat.
    ok(
      mutating.calls.refresh === 1,
      `mutating pane painted once, got ${mutating.calls.refresh}`
    )
  })

  test('repaints the mutating terminal when it is absent from the registry', () => {
    // A pane mid-mount (or mid-unmount) is not registered yet. It must still be
    // repainted — it is the one whose atlas was just repacked.
    const { addon } = makeStubAddon()
    const mutating = makeStubTerminal()
    const other = makeStubTerminal()
    correctAtlas(addon, mutating.terminal, 'sess-1', 'startup', () => [other.terminal])
    ok(mutating.calls.refresh === 1, 'unregistered mutating pane still repainted')
    ok(other.calls.refresh === 1, 'registered pane repainted')
  })

  test('one throwing sibling does not block the remaining panes', () => {
    // Terminals are disposed asynchronously; a stale registry entry must not
    // strand the panes after it in iteration order still scrambled.
    const { addon } = makeStubAddon()
    const mutating = makeStubTerminal()
    const throwing = {
      rows: 24,
      refresh() {
        throw new Error('terminal disposed')
      }
    } as unknown as ReturnType<typeof makeStubTerminal>['terminal']
    const after = makeStubTerminal()
    correctAtlas(addon, mutating.terminal, 'sess-1', 'heartbeat', () => [
      throwing,
      after.terminal
    ])
    ok(after.calls.refresh === 1, 'pane after the throwing one still repainted')
  })

  test('a throwing registry getter still repaints the mutating terminal', () => {
    const { addon, calls: addonCalls } = makeStubAddon()
    const mutating = makeStubTerminal()
    correctAtlas(addon, mutating.terminal, 'sess-1', 'heartbeat', () => {
      throw new Error('registry unavailable')
    })
    ok(addonCalls.clearedAtlas === 1, 'atlas still repacked')
    ok(mutating.calls.refresh === 1, 'mutating pane still repainted')
  })

  test('no registry supplied: behaves exactly as before (mutating pane only)', () => {
    // Back-compat — every existing call site omits the registry.
    const { addon, calls: addonCalls } = makeStubAddon()
    const mutating = makeStubTerminal()
    correctAtlas(addon, mutating.terminal, 'sess-1', 'heartbeat')
    ok(addonCalls.clearedAtlas === 1, 'atlas repacked once')
    ok(mutating.calls.refresh === 1, 'mutating pane repainted once')
  })

  test('atlas repack throwing skips the broadcast entirely', () => {
    // If `clearTextureAtlas()` threw, the atlas was not repacked, so no sibling
    // is stale — broadcasting would be pure wasted work on every pane.
    const mutating = makeStubTerminal()
    const sibling = makeStubTerminal()
    const throwingAddon = {
      clearTextureAtlas() {
        throw new Error('addon disposed')
      }
    } as unknown as WebglAddon
    correctAtlas(throwingAddon, mutating.terminal, 'sess-1', 'heartbeat', () => [
      sibling.terminal
    ])
    ok(mutating.calls.refresh === 0, 'mutating pane not repainted')
    ok(sibling.calls.refresh === 0, 'sibling not repainted')
  })

  console.log('─'.repeat(40))
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
