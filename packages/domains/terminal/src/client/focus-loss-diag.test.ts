/**
 * Root-cause classifier tests for the xterm focus-steal diagnostic.
 * Pure logic only (no DOM) — run with:
 *   pnpm tsx packages/domains/terminal/src/client/focus-loss-diag.test.ts
 */
import {
  classifyFocusLoss,
  isElementUnfocusable,
  type BlurContext,
  type FocusBlocker
} from './focus-loss-diag.js'

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}`)
    throw e
  }
}
function expect<T>(v: T) {
  return {
    toBe(e: T): void {
      if (v !== e) throw new Error(`expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`)
    }
  }
}

const NO_BLOCKER: FocusBlocker = {
  disabled: false,
  readOnly: false,
  inert: false,
  tabIndex: 0,
  contentEditable: 'false',
  inertAncestor: null
}

// A connected, visible, focusable, no-app-frames baseline; each test overrides
// what it needs.
function ctx(over: Partial<BlurContext> = {}): BlurContext {
  return {
    blurStack: '',
    textareaConnectedAtBlur: true,
    textareaConnected: true,
    terminalConnected: true,
    containerConnected: true,
    hiddenAncestor: null,
    focusBlocker: NO_BLOCKER,
    lastKey: null,
    sinceKeyMs: null,
    lastPointerTarget: null,
    sincePointerMs: null,
    sinceOutputMs: null,
    ...over
  }
}

console.log('classifyFocusLoss')

test('detached textarea → dom-teardown', () => {
  expect(classifyFocusLoss(ctx({ textareaConnected: false }))).toBe('dom-teardown')
})

test('teardown wins even when an ancestor also reads hidden', () => {
  // During unmount both can be true; teardown is the more fundamental cause.
  expect(
    classifyFocusLoss(
      ctx({
        textareaConnected: false,
        hiddenAncestor: { tag: 'DIV', reason: 'display:none', depth: 3 }
      })
    )
  ).toBe('dom-teardown')
})

test('display:none ancestor → ancestor-display-none (the tab-hide class)', () => {
  expect(
    classifyFocusLoss(ctx({ hiddenAncestor: { tag: 'DIV', reason: 'display:none', depth: 5 } }))
  ).toBe('ancestor-display-none')
})

test('visibility:hidden ancestor → ancestor-visibility-hidden', () => {
  expect(
    classifyFocusLoss(ctx({ hiddenAncestor: { tag: 'DIV', reason: 'visibility:hidden', depth: 2 } }))
  ).toBe('ancestor-visibility-hidden')
})

test('hidden attribute ancestor → ancestor-hidden-attr', () => {
  expect(
    classifyFocusLoss(ctx({ hiddenAncestor: { tag: 'SECTION', reason: 'hidden-attr', depth: 1 } }))
  ).toBe('ancestor-hidden-attr')
})

test('aria-hidden ancestor → ancestor-aria-hidden', () => {
  expect(
    classifyFocusLoss(ctx({ hiddenAncestor: { tag: 'DIV', reason: 'aria-hidden', depth: 4 } }))
  ).toBe('ancestor-aria-hidden')
})

test('hidden ancestor wins over a programmatic-looking stack', () => {
  // A tab-hide IS the cause; the commit stack is just how it happened.
  expect(
    classifyFocusLoss(
      ctx({
        hiddenAncestor: { tag: 'DIV', reason: 'display:none', depth: 5 },
        blurStack: 'at commitMutationEffects\nat Terminal'
      })
    )
  ).toBe('ancestor-display-none')
})

test('connected + visible + inert element → element-unfocusable', () => {
  expect(
    classifyFocusLoss(ctx({ focusBlocker: { ...NO_BLOCKER, inert: true } }))
  ).toBe('element-unfocusable')
})

test('connected + visible + disabled element → element-unfocusable', () => {
  expect(
    classifyFocusLoss(ctx({ focusBlocker: { ...NO_BLOCKER, disabled: true } }))
  ).toBe('element-unfocusable')
})

test('connected + visible + ancestor [inert] → element-unfocusable', () => {
  expect(
    classifyFocusLoss(
      ctx({ focusBlocker: { ...NO_BLOCKER, inertAncestor: { tag: 'DIV' } } })
    )
  ).toBe('element-unfocusable')
})

test('readOnly / tabIndex<0 alone are NOT blockers (still focusable)', () => {
  expect(isElementUnfocusable({ ...NO_BLOCKER, readOnly: true, tabIndex: -1 })).toBe(false)
  expect(
    classifyFocusLoss(
      ctx({ focusBlocker: { ...NO_BLOCKER, readOnly: true, tabIndex: -1 }, blurStack: 'native' })
    )
  ).toBe('unattributed')
})

test('hidden ancestor wins over an inert element (tab-hide grouping stays clean)', () => {
  expect(
    classifyFocusLoss(
      ctx({
        hiddenAncestor: { tag: 'DIV', reason: 'display:none', depth: 3 },
        focusBlocker: { ...NO_BLOCKER, inert: true }
      })
    )
  ).toBe('ancestor-display-none')
})

test('element-unfocusable wins over a programmatic-looking stack', () => {
  expect(
    classifyFocusLoss(
      ctx({ focusBlocker: { ...NO_BLOCKER, inert: true }, blurStack: 'at HTMLElement.blur' })
    )
  ).toBe('element-unfocusable')
})

test('connected + visible + app frames in stack → programmatic-blur', () => {
  expect(classifyFocusLoss(ctx({ blurStack: 'at HTMLElement.blur\nat focusElsewhere' }))).toBe(
    'programmatic-blur'
  )
})

test('connected + visible + Terminal frame → programmatic-blur', () => {
  expect(classifyFocusLoss(ctx({ blurStack: 'at onSomething (Terminal.tsx:42)' }))).toBe(
    'programmatic-blur'
  )
})

test('connected + visible + no app frames → unattributed', () => {
  expect(classifyFocusLoss(ctx({ blurStack: 'at dispatchEvent\nat <anonymous>' }))).toBe(
    'unattributed'
  )
})

console.log('all classifyFocusLoss tests passed')
