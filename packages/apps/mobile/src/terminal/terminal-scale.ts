/**
 * How the phone sizes a terminal it may not resize: the session keeps the columns
 * and rows its desktop gave it, and the phone picks the FONT SIZE instead. Two text
 * sizes, the user's choice (kept per device, `terminal-prefs.ts`):
 *
 * - `readable` (default): never below `READABLE_FONT` — a session wider than the
 *   screen at that size pans sideways instead of shrinking to an unreadable font;
 * - `fit`: the largest font at which every column fits the screen.
 *
 * A session that fits at a readable size shows at its fit either way. A pinch zooms
 * from there (between the fit and the largest font). Changing the font, not a CSS
 * scale, keeps the text sharp at every zoom. A monospace cell's width is proportional
 * to the font size, so one measurement at the current size gives the fit.
 *
 * A terminal the PHONE starts gets a grid sized to the phone's screen at the readable
 * font (`phoneGrid`), so it needs neither.
 */

/** Below this nothing is legible even zoomed; a very wide terminal pans instead. */
export const MIN_FONT = 2
export const MAX_FONT = 28
/**
 * The smallest font the `readable` size shows (points): small for prose, yet clearly
 * legible monospace on a phone's screen — and wide enough (~65 columns on a 390pt
 * phone) that an agent's screen needs little panning.
 */
export const READABLE_FONT = 10

export type TextSize = 'readable' | 'fit'
export const TEXT_SIZES: readonly TextSize[] = ['readable', 'fit']

/** Menlo's cell, in ems: its advance width, and xterm's line height for it. */
const CELL_WIDTH_EM = 0.6
const CELL_HEIGHT_EM = 1.2

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/**
 * The font size at which the terminal's screen is exactly `viewportWidth` wide,
 * given that it is `screenWidth` wide at `currentFont`.
 */
export function fitFontSize(
  currentFont: number,
  screenWidth: number,
  viewportWidth: number
): number {
  if (screenWidth <= 0 || viewportWidth <= 0) return clamp(currentFont, MIN_FONT, MAX_FONT)
  return clamp((currentFont * viewportWidth) / screenWidth, MIN_FONT, MAX_FONT)
}

/** The font a text size shows at, before any pinch (`fitFont`: every column fits). */
export function baseFont(textSize: TextSize, fitFont: number): number {
  return textSize === 'fit' ? fitFont : Math.min(MAX_FONT, Math.max(fitFont, READABLE_FONT))
}

/** A pinch zoom (× `base`) the user can have: from the fit up to the largest font. */
export function clampZoom(zoom: number, fitFont: number, base: number): number {
  return clamp(zoom, Math.min(1, fitFont / base), Math.max(1, MAX_FONT / base))
}

/**
 * The grid a terminal shown in `width` × `height` points has at the readable font —
 * the size the phone starts an agent at. Null when there is no area to measure yet.
 */
export function phoneGrid(width: number, height: number): { cols: number; rows: number } | null {
  if (width <= 0 || height <= 0) return null
  return {
    cols: Math.max(20, Math.floor(width / (READABLE_FONT * CELL_WIDTH_EM))),
    rows: Math.max(5, Math.floor(height / (READABLE_FONT * CELL_HEIGHT_EM)))
  }
}
