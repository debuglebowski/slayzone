/**
 * Lifecycle tests for loadWebglRenderer — verifies the WebGL renderer load/abort/
 * context-loss/font-settle logic without a GPU or a real xterm instance.
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/webgl-loader.test.ts
 */
import type { WebglAddon } from '@xterm/addon-webgl'
import { loadWebglRenderer, type LoadWebglOptions } from './webgl-loader'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`)
      passed++
    })
    .catch((e) => {
      console.error(`  ✗ ${name}`)
      console.error(`    ${e instanceof Error ? e.message : e}`)
      failed++
    })
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
  }
  addonCalls: ReturnType<typeof makeStubAddon>['calls']
  termCalls: ReturnType<typeof makeStubTerminal>['calls']
  stubAddon: WebglAddon
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
    onWebglDisabledCalls: 0
  }
  const opts: LoadWebglOptions = {
    terminal,
    createAddon: () => {
      state.createCalls++
      if (over.createThrows) throw new Error('WebGL unavailable')
      return addon
    },
    fontsReady: Promise.resolve(),
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
    }
  }
  return { opts, state, addonCalls, termCalls, stubAddon: addon }
}

async function run(): Promise<void> {
  console.log('\nloadWebglRenderer')
  console.log('─'.repeat(40))

  await test('happy path: loads addon, settles fonts, clears atlas', async () => {
    const h = harness()
    await loadWebglRenderer(h.opts)
    ok(h.state.createCalls === 1, 'createAddon called once')
    ok(h.termCalls.loadAddon === 1, 'loadAddon called')
    ok(h.state.activeAddon === h.stubAddon, 'addon stored as active')
    ok(h.addonCalls.clearedAtlas === 1, 'atlas cleared after font-settle')
    ok(h.termCalls.refresh === 1, 'screen refreshed after font-settle')
  })

  await test('aborted before start: no addon constructed', async () => {
    const h = harness()
    h.state.aborted = true
    await loadWebglRenderer(h.opts)
    ok(h.state.createCalls === 0, 'createAddon not called')
  })

  await test('webglDisabled latch: no addon constructed', async () => {
    const h = harness()
    h.state.webglDisabled = true
    await loadWebglRenderer(h.opts)
    ok(h.state.createCalls === 0, 'createAddon not called')
  })

  await test('stale terminal: no addon constructed', async () => {
    const h = harness()
    h.state.current = false
    await loadWebglRenderer(h.opts)
    ok(h.state.createCalls === 0, 'createAddon not called')
  })

  await test('construction throws: latches WebGL off, no loadAddon', async () => {
    const h = harness({ createThrows: true })
    await loadWebglRenderer(h.opts)
    ok(h.state.onWebglDisabledCalls === 1, 'onWebglDisabled called')
    ok(h.state.webglDisabled === true, 'webglDisabled latched true')
    ok(h.termCalls.loadAddon === 0, 'loadAddon not called')
  })

  await test('context loss: disposes addon, clears active ref, repaints', async () => {
    const h = harness()
    await loadWebglRenderer(h.opts)
    ok(h.addonCalls.contextLossHandler !== null, 'context-loss handler registered')
    const refreshBefore = h.termCalls.refresh
    h.addonCalls.contextLossHandler!()
    ok(h.addonCalls.disposed === 1, 'addon disposed')
    ok(h.state.activeAddon === null, 'active addon ref cleared')
    ok(h.termCalls.refresh === refreshBefore + 1, 'screen repainted on context loss')
  })

  await test('aborted during font-settle: atlas not cleared', async () => {
    const h = harness()
    const p = loadWebglRenderer(h.opts) // runs synchronously up to the fonts await
    h.state.aborted = true
    await p
    ok(h.termCalls.loadAddon === 1, 'addon still loaded')
    ok(h.addonCalls.clearedAtlas === 0, 'atlas NOT cleared after abort')
  })

  await test('addon replaced during font-settle: atlas not cleared', async () => {
    const h = harness()
    const p = loadWebglRenderer(h.opts)
    h.state.activeAddon = makeStubAddon().addon // a different addon won the slot
    await p
    ok(h.addonCalls.clearedAtlas === 0, 'atlas NOT cleared for superseded addon')
  })

  console.log('─'.repeat(40))
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

void run()
