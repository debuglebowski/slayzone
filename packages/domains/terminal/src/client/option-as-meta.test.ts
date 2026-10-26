/**
 * macOS Option key: Meta (ESC prefix) or character composition, per keystroke.
 * Issue #103: a hardcoded `macOptionIsMeta: true` made Option+2 send ESC 2 on
 * Swedish/German/Nordic layouts, so @ | \ [ ] { } ~ $ could not be typed.
 * Layout data is measured (option-as-meta.layouts.fixture.ts), not hand-typed.
 * Run with: pnpm tsx packages/domains/terminal/src/client/option-as-meta.test.ts
 */
import { isUsLikeBaseLayout, resolveOptionIsMeta, US_OPTION_LAYER } from './option-as-meta'
import { LAYOUTS, type MeasuredLayout } from './option-as-meta.layouts.fixture'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${(e as Error).message}`)
    failed++
  }
}
function eq(actual: unknown, expected: unknown, what = ''): void {
  if (actual !== expected)
    throw new Error(`${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** What `navigator.keyboard.getLayoutMap()` reports: the unmodified layer. */
function baseMap(layout: MeasuredLayout): Map<string, string> {
  return new Map(Object.entries(layout).map(([code, row]) => [code, row[0]]))
}
const NONE = { left: false, right: false }
const LEFT = { left: true, right: false }
const RIGHT = { left: false, right: true }
/** An Option(+Shift) keystroke on `layout`, as Chromium reports it. */
function optionKey(layout: MeasuredLayout, code: string, shiftKey = false) {
  return { code, key: layout[code][shiftKey ? 3 : 2], shiftKey, ctrlKey: false, metaKey: false }
}
const isPrintableAscii = (s: string): boolean => /^[\x21-\x7e]$/.test(s)

const US_LIKE = ['US', 'ABC', 'USInternationalPC', 'British', 'EurKEY']
const NON_US = ['SwedishPro', 'Swedish', 'Finnish', 'Norwegian', 'Danish', 'German', 'French']

test('US_OPTION_LAYER is the measured US Option layer', () => {
  for (const [code, row] of Object.entries(LAYOUTS.US)) {
    eq(US_OPTION_LAYER[code]?.[0], row[2], `${code} option`)
    eq(US_OPTION_LAYER[code]?.[1], row[3], `${code} shift+option`)
  }
})

test('base-layer check: US-shaped layouts are US-like', () => {
  for (const name of US_LIKE) eq(isUsLikeBaseLayout(baseMap(LAYOUTS[name])), true, name)
})

test('base-layer check: Nordic/German/French layouts are not', () => {
  for (const name of NON_US) eq(isUsLikeBaseLayout(baseMap(LAYOUTS[name])), false, name)
})

test('base-layer check: an empty/unknown map counts as US-like', () => {
  eq(isUsLikeBaseLayout(new Map()), true)
})

test('auto: every ASCII char any layout puts on Option is typed, not Meta (#103)', () => {
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    const usLike = isUsLikeBaseLayout(baseMap(layout))
    for (const code of Object.keys(layout)) {
      for (const shift of [false, true]) {
        const ev = optionKey(layout, code, shift)
        if (!isPrintableAscii(ev.key)) continue
        // The one ASCII char US itself has on Option is a duplicate of plain `.
        if (usLike && ev.key === US_OPTION_LAYER[code]?.[shift ? 1 : 0]) continue
        eq(resolveOptionIsMeta('auto', ev, NONE, usLike), false, `${name} ${code} → ${ev.key}`)
      }
    }
  }
})

test('auto: Swedish-Pro Option+2 types @ (the #103 repro)', () => {
  const sv = LAYOUTS.SwedishPro
  eq(resolveOptionIsMeta('auto', optionKey(sv, 'Digit2'), LEFT, false), false)
})

test('auto: US, ABC and US International keep every Option key as Meta', () => {
  for (const name of ['US', 'ABC', 'USInternationalPC']) {
    const layout = LAYOUTS[name]
    const usLike = isUsLikeBaseLayout(baseMap(layout))
    for (const code of Object.keys(layout)) {
      for (const shift of [false, true]) {
        const ev = optionKey(layout, code, shift)
        eq(resolveOptionIsMeta('auto', ev, NONE, usLike), true, `${name} ${code} → ${ev.key}`)
      }
    }
  }
})

test('auto: a non-US layout composes every Option key (dead keys and π too)', () => {
  for (const name of NON_US) {
    const layout = LAYOUTS[name]
    for (const code of Object.keys(layout)) {
      const ev = optionKey(layout, code)
      eq(resolveOptionIsMeta('auto', ev, NONE, false), false, `${name} ${code} → ${ev.key}`)
    }
  }
  // German ~ is Option+N, a dead key exactly like US Option+N — only the
  // base-layer check tells them apart.
  eq(LAYOUTS.German.KeyN[2], 'Dead')
  eq(resolveOptionIsMeta('auto', optionKey(LAYOUTS.German, 'KeyN'), NONE, false), false)
})

test('auto: US-shaped base, layout-specific Option chars are typed (British # and €)', () => {
  const gb = LAYOUTS.British
  eq(resolveOptionIsMeta('auto', optionKey(gb, 'Digit3'), NONE, true), false, '#')
  eq(resolveOptionIsMeta('auto', optionKey(gb, 'Digit2'), NONE, true), false, '€')
  eq(resolveOptionIsMeta('auto', optionKey(gb, 'KeyB'), NONE, true), true, '∫ = US → Meta')
  const eur = LAYOUTS.EurKEY
  eq(resolveOptionIsMeta('auto', optionKey(eur, 'KeyA'), NONE, true), false, 'EurKEY ä')
  eq(resolveOptionIsMeta('auto', optionKey(eur, 'KeyC'), NONE, true), true, 'EurKEY ç = US → Meta')
})

test('auto: Caps Lock case flip of the US char still counts as US', () => {
  const ev = { code: 'KeyA', key: 'Å', shiftKey: false, ctrlKey: false, metaKey: false }
  eq(resolveOptionIsMeta('auto', ev, NONE, true), true)
})

test('auto: keys with no Option layer (arrows, F-keys, keypad) stay Meta', () => {
  for (const code of ['ArrowLeft', 'F5', 'Numpad1', 'Enter', 'Backspace']) {
    const ev = { code, key: code, shiftKey: false, ctrlKey: false, metaKey: false }
    eq(resolveOptionIsMeta('auto', ev, NONE, true), true, code)
  }
})

test('auto: Ctrl or Cmd with Option never composes, so it is Meta', () => {
  const sv = LAYOUTS.SwedishPro
  eq(resolveOptionIsMeta('auto', { ...optionKey(sv, 'Digit2'), ctrlKey: true }, NONE, false), true)
  eq(resolveOptionIsMeta('auto', { ...optionKey(sv, 'Digit2'), metaKey: true }, NONE, false), true)
})

test('both / none are literal, whatever the layout', () => {
  const sv = optionKey(LAYOUTS.SwedishPro, 'Digit2')
  const us = optionKey(LAYOUTS.US, 'KeyB')
  for (const usLike of [true, false]) {
    eq(resolveOptionIsMeta('both', sv, NONE, usLike), true)
    eq(resolveOptionIsMeta('both', us, LEFT, usLike), true)
    eq(resolveOptionIsMeta('none', sv, RIGHT, usLike), false)
    eq(resolveOptionIsMeta('none', us, LEFT, usLike), false)
  }
})

test('left / right: only the named Option key is Meta', () => {
  const ev = optionKey(LAYOUTS.SwedishPro, 'Digit2')
  eq(resolveOptionIsMeta('left', ev, LEFT, false), true)
  eq(resolveOptionIsMeta('left', ev, RIGHT, false), false)
  eq(resolveOptionIsMeta('right', ev, RIGHT, false), true)
  eq(resolveOptionIsMeta('right', ev, LEFT, false), false)
  eq(resolveOptionIsMeta('left', ev, { left: true, right: true }, false), true)
})

test('left / right: unknown side (Option pressed before window focus) composes', () => {
  const ev = optionKey(LAYOUTS.US, 'KeyB')
  eq(resolveOptionIsMeta('left', ev, NONE, true), false)
  eq(resolveOptionIsMeta('right', ev, NONE, true), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
