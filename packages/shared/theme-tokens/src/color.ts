/**
 * Theme colour strings → sRGB hex, for clients that cannot read CSS colours — React
 * Native parses `#rrggbb[aa]` and `rgba()` but not `oklch()`, which the `slay` and
 * `slay-special` light presets use.
 *
 * Parses exactly the CSS syntaxes the presets are written in, and refuses anything
 * else (an unknown colour throws, so a preset in a new syntax fails the theme tests,
 * not a phone at runtime):
 *   #rrggbb  #rrggbbaa                              (any case)
 *   rgb(r, g, b)  rgba(r, g, b, a)                  (also `rgb(r g b / a)`)
 *   oklch(L C H)  oklch(L C H / a)                  (L 0–1 or 0–100%, H in degrees)
 * Channels 0–255, alpha 0–1 or 0–100%; out-of-range values are refused, not clamped.
 *
 * oklch → OKLab → linear sRGB → gamma sRGB (Björn Ottosson's OKLab matrices, the
 * ones CSS Color 4 uses). A colour outside sRGB is clamped per channel.
 */

/** An sRGB colour: `r`, `g`, `b` integers 0–255, `a` 0–1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTION = /^([a-z]+)\((.*)\)$/i
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i

function unsupported(input: string, why?: string): Error {
  return new Error(`Unsupported colour ${JSON.stringify(input)}${why ? `: ${why}` : ''}`)
}

/** A plain number token, or null. */
function num(token: string): number | null {
  return NUMBER.test(token) ? Number(token) : null
}

/** A number, or a percentage scaled so 100% = `percentOf`; null if neither. */
function numOrPercent(token: string, percentOf: number): number | null {
  if (token.endsWith('%')) {
    const n = num(token.slice(0, -1))
    return n === null ? null : (n / 100) * percentOf
  }
  return num(token)
}

const inRange = (n: number | null, min: number, max: number): n is number =>
  n !== null && n >= min && n <= max

/**
 * The argument list of a CSS colour function: `[components, alpha]`, alpha `null`
 * when absent. Legacy comma syntax (`a, b, c[, alpha]`) or modern space syntax
 * (`a b c[ / alpha]`), never mixed.
 */
function splitArgs(body: string, input: string, allowComma: boolean): [string[], string | null] {
  if (body.includes(',')) {
    if (!allowComma || body.includes('/')) throw unsupported(input)
    const parts = body.split(',').map((p) => p.trim())
    if (parts.length === 4) return [parts.slice(0, 3), parts[3]]
    return [parts, null]
  }
  const [main, alpha, ...rest] = body.split('/')
  if (rest.length > 0) throw unsupported(input)
  return [main.trim().split(/\s+/), alpha === undefined ? null : alpha.trim()]
}

function parseAlpha(token: string | null, input: string): number {
  if (token === null) return 1
  const a = numOrPercent(token, 1)
  if (!inRange(a, 0, 1)) throw unsupported(input, 'alpha must be 0–1 or 0–100%')
  return a
}

const toByte = (unit: number): number => Math.round(Math.min(1, Math.max(0, unit)) * 255)

/** Linear-light sRGB channel → gamma-encoded (the sRGB transfer function). */
function gammaEncode(linear: number): number {
  const abs = Math.abs(linear)
  const encoded = abs <= 0.0031308 ? 12.92 * abs : 1.055 * abs ** (1 / 2.4) - 0.055
  return Math.sign(linear) * encoded
}

/** OKLCH (L 0–1, C ≥ 0, H degrees) → gamma-encoded sRGB channels, nominally 0–1, unclamped. */
function oklchToSrgb(l: number, c: number, h: number): [number, number, number] {
  // OKLCH → OKLab (polar → cartesian)
  const hue = (h * Math.PI) / 180
  const a = c * Math.cos(hue)
  const b = c * Math.sin(hue)
  // OKLab → LMS: the matrix gives cube-root LMS, cubed back to linear
  const lms1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const lms2 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const lms3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  // LMS → linear sRGB
  const red = 4.0767416621 * lms1 - 3.3077115913 * lms2 + 0.2309699292 * lms3
  const green = -1.2684380046 * lms1 + 2.6097574011 * lms2 - 0.3413193965 * lms3
  const blue = -0.0041960863 * lms1 - 0.7034186147 * lms2 + 1.707614701 * lms3
  return [gammaEncode(red), gammaEncode(green), gammaEncode(blue)]
}

function parseHex(input: string, hex: string): Rgba {
  if (!HEX.test(hex)) throw unsupported(input, 'hex must be #rrggbb or #rrggbbaa')
  const byte = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16)
  return { r: byte(1), g: byte(3), b: byte(5), a: hex.length === 9 ? byte(7) / 255 : 1 }
}

function parseRgb(input: string, body: string): Rgba {
  const [parts, alpha] = splitArgs(body, input, true)
  if (parts.length !== 3) throw unsupported(input, 'rgb() takes 3 channels')
  const [r, g, b] = parts.map((p) => {
    const n = numOrPercent(p, 255)
    if (!inRange(n, 0, 255)) throw unsupported(input, 'channels must be 0–255 or 0–100%')
    return Math.round(n)
  })
  return { r, g, b, a: parseAlpha(alpha, input) }
}

function parseOklch(input: string, body: string): Rgba {
  const [parts, alpha] = splitArgs(body, input, false)
  if (parts.length !== 3) throw unsupported(input, 'oklch() takes L C H')
  const l = numOrPercent(parts[0], 1)
  const c = num(parts[1])
  const h = num(parts[2].replace(/deg$/i, ''))
  if (!inRange(l, 0, 1)) throw unsupported(input, 'L must be 0–1 or 0–100%')
  if (c === null || c < 0) throw unsupported(input, 'C must be a number ≥ 0')
  if (h === null) throw unsupported(input, 'H must be a number of degrees')
  const [r, g, b] = oklchToSrgb(l, c, h).map(toByte)
  return { r, g, b, a: parseAlpha(alpha, input) }
}

/** A theme colour string → sRGB. Throws on any syntax the module doc does not list. */
export function parseColor(input: string): Rgba {
  const s = input.trim()
  if (s.startsWith('#')) return parseHex(input, s)
  const fn = FUNCTION.exec(s)
  if (fn) {
    const name = fn[1].toLowerCase()
    if (name === 'rgb' || name === 'rgba') return parseRgb(input, fn[2].trim())
    if (name === 'oklch') return parseOklch(input, fn[2].trim())
  }
  throw unsupported(input)
}

const hexByte = (n: number): string => n.toString(16).padStart(2, '0')

/** sRGB → `#rrggbb` when opaque, else `#rrggbbaa` (lower case). */
export function formatHex({ r, g, b, a }: Rgba): string {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Error(`formatHex: channel ${channel} is not an integer 0–255`)
    }
  }
  if (!(a >= 0 && a <= 1)) throw new Error(`formatHex: alpha ${a} is not 0–1`)
  const alpha = Math.round(a * 255)
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}${alpha === 255 ? '' : hexByte(alpha)}`
}

/** A theme colour string → `#rrggbb[aa]`. */
export function toHex(color: string): string {
  return formatHex(parseColor(color))
}

/**
 * The colour with its alpha multiplied by `factor` (0–1), as `#rrggbb[aa]` — what a
 * Tailwind opacity modifier does to a theme token (`bg-primary/50` = `withAlpha(primary, 0.5)`).
 */
export function withAlpha(color: string, factor: number): string {
  if (!(factor >= 0 && factor <= 1)) throw new Error(`withAlpha: factor ${factor} is not 0–1`)
  const rgba = parseColor(color)
  return formatHex({ ...rgba, a: rgba.a * factor })
}

/** Every colour of a palette (chrome, terminal or editor) as `#rrggbb[aa]`, same keys. */
export function toHexColors<T extends { [K in keyof T]: string }>(colors: T): T {
  const out = {} as T
  for (const key of Object.keys(colors) as (keyof T)[]) {
    try {
      out[key] = toHex(colors[key]) as T[keyof T]
    } catch (err) {
      throw new Error(`${String(key)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}
