/**
 * macOS Option key: Meta (ESC prefix) or character composition, per keystroke.
 * Issue #103: a hardcoded `macOptionIsMeta: true` made Option+2 send ESC 2 on
 * Swedish/German/Nordic layouts, so @ | \ [ ] { } ~ $ could not be typed.
 * Layout data is measured (option-as-meta.layouts.fixture.ts), not hand-typed.
 */
import { expect, test } from 'vitest'
import { isUsLikeBaseLayout, resolveOptionIsMeta, US_OPTION_LAYER } from './option-as-meta'
import { LAYOUTS, type MeasuredLayout } from './option-as-meta.layouts.fixture'

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
    expect(US_OPTION_LAYER[code]?.[0], `${code} option`).toBe(row[2])
    expect(US_OPTION_LAYER[code]?.[1], `${code} shift+option`).toBe(row[3])
  }
})

test('base-layer check: US-shaped layouts are US-like', () => {
  for (const name of US_LIKE) expect(isUsLikeBaseLayout(baseMap(LAYOUTS[name])), name).toBe(true)
})

test('base-layer check: Nordic/German/French layouts are not', () => {
  for (const name of NON_US) expect(isUsLikeBaseLayout(baseMap(LAYOUTS[name])), name).toBe(false)
})

test('base-layer check: an empty/unknown map counts as US-like', () => {
  expect(isUsLikeBaseLayout(new Map())).toBe(true)
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
        expect(resolveOptionIsMeta('auto', ev, NONE, usLike), `${name} ${code} → ${ev.key}`).toBe(
          false
        )
      }
    }
  }
})

test('auto: Swedish-Pro Option+2 types @ (the #103 repro)', () => {
  const sv = LAYOUTS.SwedishPro
  expect(resolveOptionIsMeta('auto', optionKey(sv, 'Digit2'), LEFT, false)).toBe(false)
})

test('auto: US, ABC and US International keep every Option key as Meta', () => {
  for (const name of ['US', 'ABC', 'USInternationalPC']) {
    const layout = LAYOUTS[name]
    const usLike = isUsLikeBaseLayout(baseMap(layout))
    for (const code of Object.keys(layout)) {
      for (const shift of [false, true]) {
        const ev = optionKey(layout, code, shift)
        expect(resolveOptionIsMeta('auto', ev, NONE, usLike), `${name} ${code} → ${ev.key}`).toBe(
          true
        )
      }
    }
  }
})

test('auto: a non-US layout composes every Option key (dead keys and π too)', () => {
  for (const name of NON_US) {
    const layout = LAYOUTS[name]
    for (const code of Object.keys(layout)) {
      const ev = optionKey(layout, code)
      expect(resolveOptionIsMeta('auto', ev, NONE, false), `${name} ${code} → ${ev.key}`).toBe(
        false
      )
    }
  }
  // German ~ is Option+N, a dead key exactly like US Option+N — only the
  // base-layer check tells them apart.
  expect(LAYOUTS.German.KeyN[2]).toBe('Dead')
  expect(resolveOptionIsMeta('auto', optionKey(LAYOUTS.German, 'KeyN'), NONE, false)).toBe(false)
})

test('auto: US-shaped base, layout-specific Option chars are typed (British # and €)', () => {
  const gb = LAYOUTS.British
  expect(resolveOptionIsMeta('auto', optionKey(gb, 'Digit3'), NONE, true), '#').toBe(false)
  expect(resolveOptionIsMeta('auto', optionKey(gb, 'Digit2'), NONE, true), '€').toBe(false)
  expect(resolveOptionIsMeta('auto', optionKey(gb, 'KeyB'), NONE, true), '∫ = US → Meta').toBe(true)
  const eur = LAYOUTS.EurKEY
  expect(resolveOptionIsMeta('auto', optionKey(eur, 'KeyA'), NONE, true), 'EurKEY ä').toBe(false)
  expect(
    resolveOptionIsMeta('auto', optionKey(eur, 'KeyC'), NONE, true),
    'EurKEY ç = US → Meta'
  ).toBe(true)
})

test('auto: Caps Lock case flip of the US char still counts as US', () => {
  const ev = { code: 'KeyA', key: 'Å', shiftKey: false, ctrlKey: false, metaKey: false }
  expect(resolveOptionIsMeta('auto', ev, NONE, true)).toBe(true)
})

test('auto: keys with no Option layer (arrows, F-keys, keypad) stay Meta', () => {
  for (const code of ['ArrowLeft', 'F5', 'Numpad1', 'Enter', 'Backspace']) {
    const ev = { code, key: code, shiftKey: false, ctrlKey: false, metaKey: false }
    expect(resolveOptionIsMeta('auto', ev, NONE, true), code).toBe(true)
  }
})

test('auto: Ctrl or Cmd with Option never composes, so it is Meta', () => {
  const sv = LAYOUTS.SwedishPro
  expect(
    resolveOptionIsMeta('auto', { ...optionKey(sv, 'Digit2'), ctrlKey: true }, NONE, false)
  ).toBe(true)
  expect(
    resolveOptionIsMeta('auto', { ...optionKey(sv, 'Digit2'), metaKey: true }, NONE, false)
  ).toBe(true)
})

test('both / none are literal, whatever the layout', () => {
  const sv = optionKey(LAYOUTS.SwedishPro, 'Digit2')
  const us = optionKey(LAYOUTS.US, 'KeyB')
  for (const usLike of [true, false]) {
    expect(resolveOptionIsMeta('both', sv, NONE, usLike)).toBe(true)
    expect(resolveOptionIsMeta('both', us, LEFT, usLike)).toBe(true)
    expect(resolveOptionIsMeta('none', sv, RIGHT, usLike)).toBe(false)
    expect(resolveOptionIsMeta('none', us, LEFT, usLike)).toBe(false)
  }
})

test('left / right: only the named Option key is Meta', () => {
  const ev = optionKey(LAYOUTS.SwedishPro, 'Digit2')
  expect(resolveOptionIsMeta('left', ev, LEFT, false)).toBe(true)
  expect(resolveOptionIsMeta('left', ev, RIGHT, false)).toBe(false)
  expect(resolveOptionIsMeta('right', ev, RIGHT, false)).toBe(true)
  expect(resolveOptionIsMeta('right', ev, LEFT, false)).toBe(false)
  expect(resolveOptionIsMeta('left', ev, { left: true, right: true }, false)).toBe(true)
})

test('left / right: unknown side (Option pressed before window focus) composes', () => {
  const ev = optionKey(LAYOUTS.US, 'KeyB')
  expect(resolveOptionIsMeta('left', ev, NONE, true)).toBe(false)
  expect(resolveOptionIsMeta('right', ev, NONE, true)).toBe(false)
})
