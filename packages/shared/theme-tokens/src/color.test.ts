import { describe, expect, it } from 'vitest'
import { formatHex, parseColor, toHex, toHexColors, withAlpha, type Rgba } from './color'

/** Each channel of `actual` within ±1 of `expected` (both `#rrggbb[aa]`). */
function expectHexClose(actual: string, expected: string): void {
  expect(actual).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/)
  expect(actual.length).toBe(expected.length)
  for (let i = 1; i < expected.length; i += 2) {
    const a = Number.parseInt(actual.slice(i, i + 2), 16)
    const e = Number.parseInt(expected.slice(i, i + 2), 16)
    expect(Math.abs(a - e), `${actual} vs ${expected}, byte ${(i - 1) / 2}`).toBeLessThanOrEqual(1)
  }
}

describe('parseColor: hex', () => {
  it.each<[string, Rgba]>([
    ['#282c34', { r: 0x28, g: 0x2c, b: 0x34, a: 1 }],
    ['#2A2A2A', { r: 0x2a, g: 0x2a, b: 0x2a, a: 1 }],
    ['#ff000050', { r: 255, g: 0, b: 0, a: 0x50 / 255 }],
    ['#00000000', { r: 0, g: 0, b: 0, a: 0 }]
  ])('%s', (input, expected) => {
    expect(parseColor(input)).toEqual(expected)
  })

  it('round-trips 6 and 8 digits (lower-cased)', () => {
    for (const hex of ['#282c34', '#ff000050', '#ffffff00', '#F5F5F5']) {
      expect(toHex(hex)).toBe(hex.toLowerCase())
    }
  })
})

describe('parseColor: rgb() / rgba()', () => {
  it.each<[string, Rgba]>([
    ['rgba(255, 255, 255, 0.15)', { r: 255, g: 255, b: 255, a: 0.15 }],
    ['rgba(0, 0, 0, 0.35)', { r: 0, g: 0, b: 0, a: 0.35 }],
    ['rgba(235, 219, 178, 0.20)', { r: 235, g: 219, b: 178, a: 0.2 }],
    ['rgba(0,0,0,50%)', { r: 0, g: 0, b: 0, a: 0.5 }],
    ['rgb(40, 44, 52)', { r: 40, g: 44, b: 52, a: 1 }],
    ['rgb(40 44 52 / 0.5)', { r: 40, g: 44, b: 52, a: 0.5 }],
    ['RGBA(1, 2, 3, 1)', { r: 1, g: 2, b: 3, a: 1 }]
  ])('%s', (input, expected) => {
    expect(parseColor(input)).toEqual(expected)
  })

  it('formats alpha as the 4th hex byte', () => {
    // 0.15 × 255 = 38.25 → 0x26
    expect(toHex('rgba(255, 255, 255, 0.15)')).toBe('#ffffff26')
    expect(toHex('rgba(0, 0, 0, 0.22)')).toBe('#00000038')
    expect(toHex('rgba(40, 44, 52, 1)')).toBe('#282c34')
  })
})

describe('parseColor: oklch()', () => {
  // References: lightningcss 1.x downlevelling `color: oklch(…)` to hex for an old
  // Safari target (an independent implementation), all inside the sRGB gamut, where
  // it does no gamut mapping. Neutral ones are the `slay` light chrome values.
  it.each([
    ['oklch(1 0 0)', '#ffffff'],
    ['oklch(0 0 0)', '#000000'],
    ['oklch(0.985 0 0)', '#fafafa'],
    ['oklch(0.94 0 0)', '#ebebeb'],
    ['oklch(0.55 0 0)', '#717171'],
    ['oklch(0.45 0 0)', '#555555'],
    ['oklch(0.205 0 0)', '#171717'],
    ['oklch(0.13 0 0)', '#070707'],
    ['oklch(0.398 0.07 227.392)', '#104e64'],
    ['oklch(0.7 0.1 250)', '#6da3da'],
    ['oklch(0.5 0.08 140)', '#4a6e42'],
    ['oklch(0.8 0.05 30)', '#dcb2ab'],
    ['oklch(0.62 0.15 300)', '#956ed2'],
    ['oklch(0.45 0.1 20)', '#843b3e'],
    ['oklch(0.9 0.04 100)', '#e4dfc1']
  ])('%s → %s (±1 per channel)', (input, expected) => {
    expectHexClose(toHex(input), expected)
  })

  it('reads L as a percentage and H with a deg unit', () => {
    expect(toHex('oklch(70% 0.1 250)')).toBe(toHex('oklch(0.7 0.1 250)'))
    expect(toHex('oklch(0.7 0.1 250deg)')).toBe(toHex('oklch(0.7 0.1 250)'))
  })

  it.each([
    ['oklch(0 0 0 / 22%)', '#00000038'],
    ['oklch(0 0 0 / 35%)', '#00000059'],
    ['oklch(0.7 0.1 250 / 0.5)', '#6da3da80'],
    ['oklch(0.3 0.05 200 / 35%)', '#02353859']
  ])('alpha: %s → %s', (input, expected) => {
    expectHexClose(toHex(input), expected)
  })

  // Outside sRGB: each channel is clamped to 0–255 (so these differ from a CSS gamut
  // mapper's chroma reduction). Expected values: the same math in an independent
  // script, clamped; they equal the Tailwind v4 palette's published hex values.
  it.each([
    ['oklch(0.577 0.245 27.325)', '#e7000b'],
    ['oklch(0.646 0.222 41.116)', '#f54900'],
    ['oklch(0.6 0.118 184.704)', '#009689'],
    ['oklch(0.828 0.189 84.429)', '#ffb900'],
    ['oklch(0.769 0.188 70.08)', '#fe9a00']
  ])('clamps out-of-gamut %s → %s', (input, expected) => {
    expectHexClose(toHex(input), expected)
  })
})

describe('parseColor: refuses what it does not read', () => {
  it.each([
    '',
    'red',
    'transparent',
    '#fff',
    '#ffff',
    '#fffff',
    '#gggggg',
    '282c34',
    'hsl(0 0% 50%)',
    'var(--background)',
    'color-mix(in oklab, red 50%, transparent)',
    'oklab(0.5 0 0)',
    'rgba(256, 0, 0, 1)',
    'rgba(-1, 0, 0, 1)',
    'rgba(0, 0, 0, 1.5)',
    'rgba(0, 0, 0)  extra',
    'rgb(0, 0)',
    'rgb(0, 0, 0, 0, 0)',
    'rgb(0 0 0, 1)',
    'rgb(0, 0, 0 / 1)',
    'oklch(1.2 0 0)',
    'oklch(0.5 0.1)',
    'oklch(0.5, 0.1, 20)',
    'oklch(0.5 -0.1 20)',
    'oklch(0.5 0.1 none)',
    'oklch(0.5 0.1 20 / 2)',
    'oklch(0.5 0.1 20 / 1 / 1)'
  ])('%j', (input) => {
    expect(() => parseColor(input)).toThrow(/Unsupported colour/)
  })
})

describe('formatHex', () => {
  it('is #rrggbb when opaque, #rrggbbaa otherwise', () => {
    expect(formatHex({ r: 1, g: 2, b: 255, a: 1 })).toBe('#0102ff')
    expect(formatHex({ r: 1, g: 2, b: 255, a: 0 })).toBe('#0102ff00')
    expect(formatHex({ r: 1, g: 2, b: 255, a: 0.5 })).toBe('#0102ff80')
  })

  it('refuses non-byte channels and alpha outside 0–1', () => {
    expect(() => formatHex({ r: 1.5, g: 0, b: 0, a: 1 })).toThrow()
    expect(() => formatHex({ r: 256, g: 0, b: 0, a: 1 })).toThrow()
    expect(() => formatHex({ r: 0, g: 0, b: 0, a: 1.1 })).toThrow()
    expect(() => formatHex({ r: 0, g: 0, b: 0, a: Number.NaN })).toThrow()
  })
})

describe('withAlpha (Tailwind /NN)', () => {
  it('sets alpha on an opaque colour', () => {
    expect(withAlpha('#ffffff', 0.5)).toBe('#ffffff80')
    expect(withAlpha('oklch(0.205 0 0)', 0.5)).toBe('#17171780')
  })

  it('multiplies an existing alpha', () => {
    // 0.20 × 0.5 = 0.10 → 25.5 → 0x1a
    expect(withAlpha('rgba(255, 255, 255, 0.20)', 0.5)).toBe('#ffffff1a')
    // 0.22 × 0.5 = 0.11 → 28.05 → 0x1c
    expect(withAlpha('oklch(0 0 0 / 22%)', 0.5)).toBe('#0000001c')
    expect(withAlpha('#ff000050', 1)).toBe('#ff000050')
    expect(withAlpha('#ff000050', 0)).toBe('#ff000000')
  })

  it('refuses a factor outside 0–1 and an unsupported colour', () => {
    expect(() => withAlpha('#ffffff', 1.5)).toThrow()
    expect(() => withAlpha('#ffffff', -0.1)).toThrow()
    expect(() => withAlpha('#ffffff', Number.NaN)).toThrow()
    expect(() => withAlpha('red', 0.5)).toThrow(/Unsupported colour/)
  })
})

describe('toHexColors', () => {
  it('converts every key, keeping the keys', () => {
    expect(toHexColors({ a: '#282c34', b: 'oklch(1 0 0)', c: 'rgba(0, 0, 0, 0.5)' })).toEqual({
      a: '#282c34',
      b: '#ffffff',
      c: '#00000080'
    })
  })

  it('names the key of a colour it cannot read', () => {
    expect(() => toHexColors({ ok: '#000000', border: 'hsl(0 0% 0%)' })).toThrow(
      /^border: Unsupported colour/
    )
  })
})
