/**
 * WebGL renderer budget + parked renderer — the boot-time renderer economy for
 * many restored terminals (webgl-budget.ts, renderer-park.ts, terminal-mru.ts).
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/webgl-budget.test.ts
 */
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

console.log('\nwebgl budget')
console.log('─'.repeat(40))

test('pickEvictions: under the cap evicts nothing', () => {
  const es = [entry('a'), entry('b')]
  ok(pickEvictions(es, 8, () => 0).length === 0, 'nothing evicted')
})

test('pickEvictions: evicts least recently used off-screen renderers first', () => {
  const es = ['a', 'b', 'c', 'd'].map((s) => entry(s))
  const rank: Record<string, number> = { a: 0, b: 3, c: 1, d: 2 }
  const out = pickEvictions(es, 2, (s) => rank[s])
  ok(out.map((e) => e.sessionId).join() === 'b,d', `evicted ${out.map((e) => e.sessionId)}`)
})

test('pickEvictions: never evicts an on-screen renderer, even over the cap', () => {
  const es = [entry('a', true), entry('b', true), entry('c', true)]
  ok(pickEvictions(es, 1, () => 0).length === 0, 'on-screen renderers kept')
})

test('track / dispose: any dispose untracks through the wrapper', () => {
  __resetWebglBudgetForTest()
  const e = entry('a')
  trackWebglAddon(e)
  ok(isLiveWebglAddon(e.addon), 'tracked')
  ok(liveWebglCount() === 1, 'counted')
  e.addon.dispose()
  ok(!isLiveWebglAddon(e.addon), 'untracked on dispose')
  ok(e.disposed() === 1, 'original dispose ran once')
  ok(liveWebglCount() === 0, 'count dropped')
})

test('enforceWebglBudget: evicts down to the cap by MRU', () => {
  __resetWebglBudgetForTest()
  __setTerminalMruForTest(['s0', 's1', 's2', 's3', 's4'])
  const es = ['s4', 's3', 's2', 's1', 's0'].map((s) => entry(s))
  for (const e of es) trackWebglAddon(e)
  enforceWebglBudget(3)
  const evicted = es.filter((e) => e.evicted()).map((e) => e.sessionId)
  ok(evicted.sort().join() === 's3,s4', `evicted ${evicted}`)
  ok(liveWebglCount() === 3, `live ${liveWebglCount()}`)
})

test('re-tracking an addon replaces its entry (new owner refs) without double-wrap', () => {
  __resetWebglBudgetForTest()
  const e = entry('a')
  trackWebglAddon(e)
  trackWebglAddon({ ...e, isOnScreen: () => true })
  enforceWebglBudget(0)
  ok(isLiveWebglAddon(e.addon), 'on-screen per the newer entry → kept')
  e.addon.dispose()
  ok(e.disposed() === 1, 'single wrapper: original dispose once')
})

test('mru: touch moves to front; unknown sessions rank last', () => {
  __setTerminalMruForTest(['a', 'b'])
  touchTerminalMru('b')
  ok(mruRank('b') === 0 && mruRank('a') === 1, 'b first')
  ok(mruRank('zzz') > 1000, 'unknown last')
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
  ok(findWebglCanvasIn(root) === (render as unknown), 'render canvas')
  ok(selector === '.xterm-screen > canvas', `scoped to the screen: ${selector}`)
  ok(findWebglCanvasIn(null) === null, 'no root')
})

console.log('\nparked renderer')
console.log('─'.repeat(40))

test('cell metrics match WebGL (device-pixel floored), not DOM (fractional)', () => {
  // Menlo 15px measured 9.0308px wide in the live app.
  const d1 = webglCellDimensions(9.0308, 18, 1, 1, 0, 100, 30)
  ok(d1.css.cell.width === 9, `dpr1 width ${d1.css.cell.width}`)
  const d2 = webglCellDimensions(7.83, 17.2, 2, 1, 0, 80, 24)
  ok(d2.device.cell.width === 15 && d2.css.cell.width === 7.5, `dpr2 ${d2.css.cell.width}`)
  ok(d2.device.cell.height === 35 && d2.css.cell.height === 17.5, `h ${d2.css.cell.height}`)
  ok(webglCellDimensions(0, 0, 1, 1, 0, 80, 24).css.cell.width === 0, 'unmeasured → 0')
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
  ok(parkBeforeOpen(f.terminal), 'parked')
  f.open()
  ok(f.core.domCreated === 0, 'no DOM renderer built')
  ok(isParked(f.terminal), 'isParked')
  const dims = (f.core.renderer as unknown as { dimensions: { css: { cell: { width: number } } } })
    .dimensions
  ok(dims.css.cell.width === 9, `cell ${dims.css.cell.width}`)
})

test('swapping in another renderer un-parks (WebGL load path)', () => {
  const f = fakeTerminal()
  parkBeforeOpen(f.terminal)
  f.open()
  ;(
    f.terminal as unknown as { _core: { _renderService: { setRenderer: (r: unknown) => void } } }
  )._core._renderService.setRenderer({ dispose: () => {} })
  ok(!isParked(f.terminal), 'replaced renderer disposed the parked one')
})

test('unparkToDom: builds the DOM renderer only for a parked terminal', () => {
  const f = fakeTerminal()
  parkBeforeOpen(f.terminal)
  f.open()
  unparkToDom(f.terminal)
  ok(f.core.domCreated === 1 && !isParked(f.terminal), 'DOM renderer now')
  unparkToDom(f.terminal)
  ok(f.core.domCreated === 1, 'no-op when not parked')
})

test('parkRenderer after eviction: parks an opened terminal', () => {
  const f = fakeTerminal()
  f.open()
  ok(f.core.domCreated === 1, 'DOM renderer from a plain open')
  ok(parkRenderer(f.terminal) && isParked(f.terminal), 'parked')
})

test('wakeRenderer: runs the visible-handling now and requests a repaint', () => {
  const f = fakeTerminal()
  f.open()
  wakeRenderer(f.terminal)
  ok(f.core.intersections === 1 && !f.core.paused, 'unpaused')
  ok(f.core.refreshes === 1, 'repaint requested')
  wakeRenderer(f.terminal)
  ok(f.core.intersections === 1, 'no-op when not paused')
})

test('no xterm internals: every entry point is a safe no-op', () => {
  const bare = { cols: 80, rows: 24, refresh: () => {} } as unknown as XTerm
  ok(!parkBeforeOpen(bare) && !parkRenderer(bare) && !isParked(bare), 'nothing parked')
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
    ok(xterm.includes(k), `@xterm/xterm lacks ${k}`)
  }
  const webgl = readFileSync(require.resolve('@xterm/addon-webgl/lib/addon-webgl.mjs'), 'utf8')
  ok(webgl.includes('_gl='), '@xterm/addon-webgl renderer lacks _gl')
})

console.log('\n' + '─'.repeat(40))
console.log(`${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
