/**
 * WebGL renderer budget + parked renderer — the boot-time renderer economy for
 * many restored terminals (webgl-budget.ts, renderer-park.ts, terminal-mru.ts).
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal as XTerm } from '@xterm/xterm'
import {
  __resetWebglBudgetForTest,
  enforceWebglBudget,
  findWebglCanvasIn,
  isLiveWebglAddon,
  liveWebglCount,
  pickEvictions,
  trackWebglAddon,
  type WebglBudgetEntry
} from './webgl-budget'
import { __setTerminalMruForTest, mruRank, touchTerminalMru } from './terminal-mru'
import {
  isParked,
  parkBeforeOpen,
  parkRenderer,
  unparkToDom,
  wakeRenderer,
  webglCellDimensions
} from './renderer-park'

function stubAddon(): { addon: WebglAddon; disposed: () => number } {
  let n = 0
  const addon = {
    dispose(): void {
      n++
    }
  }
  return { addon: addon as unknown as WebglAddon, disposed: () => n }
}

function entry(
  sessionId: string,
  onScreen = false
): WebglBudgetEntry & { evicted: () => boolean; disposed: () => number } {
  const { addon, disposed } = stubAddon()
  let evicted = false
  return {
    sessionId,
    addon,
    isOnScreen: () => onScreen,
    evict: () => {
      evicted = true
      addon.dispose()
    },
    evicted: () => evicted,
    disposed
  }
}

describe('webgl budget', () => {
  test('pickEvictions: under the cap evicts nothing', () => {
    const es = [entry('a'), entry('b')]
    expect(pickEvictions(es, 8, () => 0), 'nothing evicted').toHaveLength(0)
  })

  test('pickEvictions: evicts least recently used off-screen renderers first', () => {
    const es = ['a', 'b', 'c', 'd'].map((s) => entry(s))
    const rank: Record<string, number> = { a: 0, b: 3, c: 1, d: 2 }
    const out = pickEvictions(es, 2, (s) => rank[s])
    expect(out.map((e) => e.sessionId).join(), `evicted ${out.map((e) => e.sessionId)}`).toBe('b,d')
  })

  test('pickEvictions: never evicts an on-screen renderer, even over the cap', () => {
    const es = [entry('a', true), entry('b', true), entry('c', true)]
    expect(pickEvictions(es, 1, () => 0), 'on-screen renderers kept').toHaveLength(0)
  })

  test('track / dispose: any dispose untracks through the wrapper', () => {
    __resetWebglBudgetForTest()
    const e = entry('a')
    trackWebglAddon(e)
    expect(isLiveWebglAddon(e.addon), 'tracked').toBe(true)
    expect(liveWebglCount(), 'counted').toBe(1)
    e.addon.dispose()
    expect(isLiveWebglAddon(e.addon), 'untracked on dispose').toBe(false)
    expect(e.disposed(), 'original dispose ran once').toBe(1)
    expect(liveWebglCount(), 'count dropped').toBe(0)
  })

  test('enforceWebglBudget: evicts down to the cap by MRU', () => {
    __resetWebglBudgetForTest()
    __setTerminalMruForTest(['s0', 's1', 's2', 's3', 's4'])
    const es = ['s4', 's3', 's2', 's1', 's0'].map((s) => entry(s))
    for (const e of es) trackWebglAddon(e)
    enforceWebglBudget(3)
    const evicted = es.filter((e) => e.evicted()).map((e) => e.sessionId)
    expect(evicted.sort().join(), `evicted ${evicted}`).toBe('s3,s4')
    expect(liveWebglCount(), `live ${liveWebglCount()}`).toBe(3)
  })

  test('re-tracking an addon replaces its entry (new owner refs) without double-wrap', () => {
    __resetWebglBudgetForTest()
    const e = entry('a')
    trackWebglAddon(e)
    trackWebglAddon({ ...e, isOnScreen: () => true })
    enforceWebglBudget(0)
    expect(isLiveWebglAddon(e.addon), 'on-screen per the newer entry → kept').toBe(true)
    e.addon.dispose()
    expect(e.disposed(), 'single wrapper: original dispose once').toBe(1)
  })

  test('mru: touch moves to front; unknown sessions rank last', () => {
    __setTerminalMruForTest(['a', 'b'])
    touchTerminalMru('b')
    expect(mruRank('b'), 'b first').toBe(0)
    expect(mruRank('a'), 'b first').toBe(1)
    expect(mruRank('zzz'), 'unknown last').toBeGreaterThan(1000)
  })

  test('findWebglCanvasIn: picks the class-less render canvas, not an overlay layer', () => {
    const layer = { className: 'xterm-link-layer' }
    const render = { className: '' }
    let selector = ''
    const root = {
      querySelectorAll: (sel: string) => {
        selector = sel
        return [layer, render]
      }
    } as unknown as Element
    expect(findWebglCanvasIn(root), 'render canvas').toBe((render as unknown))
    expect(selector, `scoped to the screen: ${selector}`).toBe('.xterm-screen > canvas')
    expect(findWebglCanvasIn(null), 'no root').toBe(null)
  })
})

describe('parked renderer', () => {
  test('cell metrics match WebGL (device-pixel floored), not DOM (fractional)', () => {
    // Menlo 15px measured 9.0308px wide in the live app.
    const d1 = webglCellDimensions(9.0308, 18, 1, 1, 0, 100, 30)
    expect(d1.css.cell.width, `dpr1 width ${d1.css.cell.width}`).toBe(9)
    const d2 = webglCellDimensions(7.83, 17.2, 2, 1, 0, 80, 24)
    expect(d2.device.cell.width, `dpr2 ${d2.css.cell.width}`).toBe(15)
    expect(d2.css.cell.width, `dpr2 ${d2.css.cell.width}`).toBe(7.5)
    expect(d2.device.cell.height, `h ${d2.css.cell.height}`).toBe(35)
    expect(d2.css.cell.height, `h ${d2.css.cell.height}`).toBe(17.5)
    expect(webglCellDimensions(0, 0, 1, 1, 0, 80, 24).css.cell.width, 'unmeasured → 0').toBe(0)
  })

  /** Fake xterm core with the internals renderer-park touches. */
  function fakeTerminal(): {
    terminal: XTerm
    core: {
      element?: object
      willOpen: Array<() => void>
      renderer: { dispose: () => void; dimensions?: { css: { cell: { width: number } } } } | null
      domCreated: number
      paused: boolean
      intersections: number
      refreshes: number
    }
    open: () => void
  } {
    const core = {
      element: undefined as object | undefined,
      willOpen: [] as Array<() => void>,
      renderer: null as { dispose: () => void } | null,
      domCreated: 0,
      paused: true,
      intersections: 0,
      refreshes: 0
    }
    const renderService = {
      hasRenderer: () => !!core.renderer,
      setRenderer: (r: { dispose: () => void }) => {
        core.renderer?.dispose()
        core.renderer = r
      },
      handleResize: () => {},
      get _isPaused() {
        return core.paused
      },
      _handleIntersectionChange: (e: { isIntersecting: boolean }) => {
        core.intersections++
        core.paused = !e.isIntersecting
      }
    }
    const coreObj = {
      get element() {
        return core.element
      },
      onWillOpen: (l: () => void) => {
        core.willOpen.push(l)
        return { dispose: () => (core.willOpen = core.willOpen.filter((x) => x !== l)) }
      },
      _renderService: renderService,
      _charSizeService: { width: 9.0308, height: 18 },
      _coreBrowserService: { dpr: 1 },
      optionsService: { rawOptions: { lineHeight: 1, letterSpacing: 0 } },
      _createRenderer: () => {
        core.domCreated++
        return { dispose: () => {} }
      },
      cols: 80,
      rows: 24
    }
    const terminal = {
      _core: coreObj,
      cols: 80,
      rows: 24,
      refresh: () => {
        core.refreshes++
      }
    } as unknown as XTerm
    const open = (): void => {
      core.element = {}
      for (const l of [...core.willOpen]) l()
      if (!renderService.hasRenderer()) renderService.setRenderer(coreObj._createRenderer())
    }
    return { terminal, core, open }
  }

  test('parkBeforeOpen: open() builds no DOM renderer; parked reports WebGL cell size', () => {
    const f = fakeTerminal()
    expect(parkBeforeOpen(f.terminal), 'parked').toBe(true)
    f.open()
    expect(f.core.domCreated, 'no DOM renderer built').toBe(0)
    expect(isParked(f.terminal), 'isParked').toBe(true)
    const dims = (f.core.renderer as unknown as { dimensions: { css: { cell: { width: number } } } })
      .dimensions
    expect(dims.css.cell.width, `cell ${dims.css.cell.width}`).toBe(9)
  })

  test('swapping in another renderer un-parks (WebGL load path)', () => {
    const f = fakeTerminal()
    parkBeforeOpen(f.terminal)
    f.open()
    ;(
      f.terminal as unknown as { _core: { _renderService: { setRenderer: (r: unknown) => void } } }
    )._core._renderService.setRenderer({ dispose: () => {} })
    expect(isParked(f.terminal), 'replaced renderer disposed the parked one').toBe(false)
  })

  test('unparkToDom: builds the DOM renderer only for a parked terminal', () => {
    const f = fakeTerminal()
    parkBeforeOpen(f.terminal)
    f.open()
    unparkToDom(f.terminal)
    expect(f.core.domCreated, 'DOM renderer now').toBe(1)
    expect(isParked(f.terminal), 'DOM renderer now').toBe(false)
    unparkToDom(f.terminal)
    expect(f.core.domCreated, 'no-op when not parked').toBe(1)
  })

  test('parkRenderer after eviction: parks an opened terminal', () => {
    const f = fakeTerminal()
    f.open()
    expect(f.core.domCreated, 'DOM renderer from a plain open').toBe(1)
    expect(parkRenderer(f.terminal), 'parked').toBe(true)
    expect(isParked(f.terminal), 'parked').toBe(true)
  })

  test('wakeRenderer: runs the visible-handling now and requests a repaint', () => {
    const f = fakeTerminal()
    f.open()
    wakeRenderer(f.terminal)
    expect(f.core.intersections, 'unpaused').toBe(1)
    expect(f.core.paused, 'unpaused').toBe(false)
    expect(f.core.refreshes, 'repaint requested').toBe(1)
    wakeRenderer(f.terminal)
    expect(f.core.intersections, 'no-op when not paused').toBe(1)
  })

  test('no xterm internals: every entry point is a safe no-op', () => {
    const bare = { cols: 80, rows: 24, refresh: () => {} } as unknown as XTerm
    expect(parkBeforeOpen(bare), 'nothing parked').toBe(false)
    expect(parkRenderer(bare), 'nothing parked').toBe(false)
    expect(isParked(bare), 'nothing parked').toBe(false)
    unparkToDom(bare)
    wakeRenderer(bare)
  })

  test('shipped xterm bundles still expose the internals renderer-park relies on', () => {
    const require = createRequire(import.meta.url)
    const xterm = readFileSync(require.resolve('@xterm/xterm/lib/xterm.mjs'), 'utf8')
    for (const k of [
      'onWillOpen',
      '_createRenderer',
      'hasRenderer',
      'setRenderer',
      '_handleIntersectionChange',
      '_isPaused',
      '_charSizeService',
      '_coreBrowserService'
    ]) {
      expect(xterm.includes(k), `@xterm/xterm lacks ${k}`).toBe(true)
    }
    const webgl = readFileSync(require.resolve('@xterm/addon-webgl/lib/addon-webgl.mjs'), 'utf8')
    expect(webgl.includes('_gl='), '@xterm/addon-webgl renderer lacks _gl').toBe(true)
  })
})
