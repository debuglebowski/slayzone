/**
 * Lifecycle tests for loadWebglRenderer — verifies the WebGL renderer
 * load / guard / context-loss logic without a GPU or a real xterm instance.
 */
import { describe, expect, test } from 'vitest'
import type { WebglAddon } from '@xterm/addon-webgl'
import {
  loadWebglRenderer,
  correctAtlas,
  downgradeToDom,
  type DowngradeReason,
  type LoadWebglOptions
} from './webgl-loader'

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

describe('loadWebglRenderer', () => {
  test('happy path: constructs addon, registers context-loss, stores active', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    expect(h.state.createCalls, 'createAddon called once').toBe(1)
    expect(h.termCalls.loadAddon, 'loadAddon called').toBe(1)
    expect(h.termCalls.loadedAddon, 'the constructed addon was loaded').toBe(h.stubAddon)
    expect(h.state.activeAddon, 'addon stored as active').toBe(h.stubAddon)
    expect(h.addonCalls.contextLossHandler, 'context-loss handler registered').not.toBe(null)
  })

  test('aborted: no addon constructed', () => {
    const h = harness()
    h.state.aborted = true
    loadWebglRenderer(h.opts)
    expect(h.state.createCalls, 'createAddon not called').toBe(0)
  })

  test('webglDisabled latch: no addon constructed', () => {
    const h = harness()
    h.state.webglDisabled = true
    loadWebglRenderer(h.opts)
    expect(h.state.createCalls, 'createAddon not called').toBe(0)
  })

  test('stale terminal: no addon constructed', () => {
    const h = harness()
    h.state.current = false
    loadWebglRenderer(h.opts)
    expect(h.state.createCalls, 'createAddon not called').toBe(0)
  })

  test('addon already active: skips, no second addon constructed', () => {
    const h = harness()
    h.state.activeAddon = makeStubAddon().addon
    loadWebglRenderer(h.opts)
    expect(h.state.createCalls, 'createAddon not called').toBe(0)
    expect(h.termCalls.loadAddon, 'loadAddon not called').toBe(0)
  })

  test('construction throws: latches WebGL off, no loadAddon', () => {
    const h = harness({ createThrows: true })
    loadWebglRenderer(h.opts)
    expect(h.state.onWebglDisabledCalls, 'onWebglDisabled called').toBe(1)
    expect(h.state.webglDisabled, 'webglDisabled latched true').toBe(true)
    expect(h.termCalls.loadAddon, 'loadAddon not called').toBe(0)
  })

  test('cold-start correction: re-rasterizes + repaints on the frame then each straggler', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    expect(h.addonCalls.clearedAtlas, 'nothing corrected synchronously').toBe(0)
    expect(h.termCalls.refresh, 'screen not refreshed synchronously').toBe(0)
    h.flushFrames()
    expect(h.addonCalls.clearedAtlas, 'atlas re-rasterized on the next frame').toBe(1)
    expect(h.termCalls.refresh, 'screen repainted on the next frame').toBe(1)
    expect(
      h.state.timers.map((t) => t.ms).join(','),
      'straggler corrections scheduled at 250ms + 750ms'
    ).toBe('250,750')
    h.flushTimers()
    expect(h.addonCalls.clearedAtlas, 'atlas re-rasterized again on each straggler').toBe(3)
    expect(h.termCalls.refresh, 'screen repainted again on each straggler').toBe(3)
  })

  test('cold-start correction skipped: terminal unmounted before correcting', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    h.state.aborted = true
    h.flushFrames()
    h.flushTimers()
    expect(h.addonCalls.clearedAtlas, 'atlas not cleared after abort').toBe(0)
    expect(h.termCalls.refresh, 'screen not refreshed after abort').toBe(0)
  })

  test('cold-start correction skipped: addon superseded before correcting', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    h.state.activeAddon = makeStubAddon().addon // a different addon won the slot
    h.flushFrames()
    h.flushTimers()
    expect(h.addonCalls.clearedAtlas, 'atlas not cleared for superseded addon').toBe(0)
  })

  test('context loss: disposes addon, clears active ref, repaints, fires onDowngrade', () => {
    const h = harness()
    loadWebglRenderer(h.opts)
    expect(h.addonCalls.contextLossHandler, 'context-loss handler registered').not.toBe(null)
    const refreshBefore = h.termCalls.refresh
    h.addonCalls.contextLossHandler!()
    expect(h.addonCalls.disposed, 'addon disposed').toBe(1)
    expect(h.state.activeAddon, 'active addon ref cleared').toBe(null)
    expect(h.termCalls.refresh, 'screen repainted on context loss').toBe(refreshBefore + 1)
    expect(h.state.downgrades, 'onDowngrade fired with reason=context-loss').toEqual([
      'context-loss'
    ])
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
    expect(addonCalls.disposed, 'addon disposed').toBe(1)
    expect(active, 'active addon cleared').toBe(null)
    expect(termCalls.refresh, 'screen repainted').toBe(1)
    expect(downgrades, 'onDowngrade fired with reason').toEqual(['canary'])
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
    expect(addonCalls.disposed, 'old addon still disposed').toBe(1)
    expect(active, 'newer addon slot untouched').toBe(newer)
    expect(downgrades[0], 'onDowngrade still fires with caller-supplied reason').toBe('frame-time')
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
    expect(active, 'active addon ref still cleared after throw').toBe(null)
    expect(termCalls.refresh, 'refresh still attempted after dispose throw').toBe(1)
    expect(downgrades[0], 'onDowngrade still fires after dispose throw').toBe('manual')
  })

  test('correctAtlas: re-rasterizes the atlas and repaints every visible row', () => {
    const { addon, calls: addonCalls } = makeStubAddon()
    const { terminal, calls: termCalls } = makeStubTerminal()
    correctAtlas(addon, terminal)
    expect(addonCalls.clearedAtlas, 'atlas re-rasterized once').toBe(1)
    expect(termCalls.refresh, 'screen repainted once').toBe(1)
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
    expect(termCalls.refresh, 'refresh not reached after the throw').toBe(0)
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
    expect(withSite.calls.clearedAtlas, 'atlas re-rasterized once with a site label').toBe(1)
    expect(withSiteTerm.calls.refresh, 'screen repainted once with a site label').toBe(1)

    const noSite = makeStubAddon()
    const noSiteTerm = makeStubTerminal()
    correctAtlas(noSite.addon, noSiteTerm.terminal, 'sess-1')
    expect(
      noSite.calls.clearedAtlas,
      'labelled and unlabelled corrections produce identical render calls'
    ).toBe(withSite.calls.clearedAtlas)
    expect(
      noSiteTerm.calls.refresh,
      'labelled and unlabelled corrections produce identical render calls'
    ).toBe(withSiteTerm.calls.refresh)
  })
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
describe('correctAtlas — shared-atlas sibling repair', () => {
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
    expect(addonCalls.clearedAtlas, 'atlas repacked exactly once').toBe(1)
    expect(siblingA.calls.refresh, 'sibling A got a frame').toBe(1)
    expect(siblingB.calls.refresh, 'sibling B got a frame').toBe(1)
    // The mutating pane must be painted exactly once even though it appears in
    // the registry — a double refresh would be wasted GPU work every heartbeat.
    expect(mutating.calls.refresh, `mutating pane painted once, got ${mutating.calls.refresh}`).toBe(1)
  })

  test('repaints the mutating terminal when it is absent from the registry', () => {
    // A pane mid-mount (or mid-unmount) is not registered yet. It must still be
    // repainted — it is the one whose atlas was just repacked.
    const { addon } = makeStubAddon()
    const mutating = makeStubTerminal()
    const other = makeStubTerminal()
    correctAtlas(addon, mutating.terminal, 'sess-1', 'startup', () => [other.terminal])
    expect(mutating.calls.refresh, 'unregistered mutating pane still repainted').toBe(1)
    expect(other.calls.refresh, 'registered pane repainted').toBe(1)
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
    correctAtlas(addon, mutating.terminal, 'sess-1', 'heartbeat', () => [throwing, after.terminal])
    expect(after.calls.refresh, 'pane after the throwing one still repainted').toBe(1)
  })

  test('a throwing registry getter still repaints the mutating terminal', () => {
    const { addon, calls: addonCalls } = makeStubAddon()
    const mutating = makeStubTerminal()
    correctAtlas(addon, mutating.terminal, 'sess-1', 'heartbeat', () => {
      throw new Error('registry unavailable')
    })
    expect(addonCalls.clearedAtlas, 'atlas still repacked').toBe(1)
    expect(mutating.calls.refresh, 'mutating pane still repainted').toBe(1)
  })

  test('no registry supplied: behaves exactly as before (mutating pane only)', () => {
    // Back-compat — every existing call site omits the registry.
    const { addon, calls: addonCalls } = makeStubAddon()
    const mutating = makeStubTerminal()
    correctAtlas(addon, mutating.terminal, 'sess-1', 'heartbeat')
    expect(addonCalls.clearedAtlas, 'atlas repacked once').toBe(1)
    expect(mutating.calls.refresh, 'mutating pane repainted once').toBe(1)
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
    correctAtlas(throwingAddon, mutating.terminal, 'sess-1', 'heartbeat', () => [sibling.terminal])
    expect(mutating.calls.refresh, 'mutating pane not repainted').toBe(0)
    expect(sibling.calls.refresh, 'sibling not repainted').toBe(0)
  })
})
