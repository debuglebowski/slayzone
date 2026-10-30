/**
 * How the phone sizes a terminal it may not resize: the session keeps the columns
 * and rows its desktop gave it, and the phone picks the FONT SIZE instead — the
 * largest at which every column fits the screen ("fit"), times a zoom the user
 * pinches (from 1 = fit up to the largest font). Changing the font, not a CSS scale,
 * keeps the text sharp at every zoom. A monospace cell's width is proportional to
 * the font size, so one measurement at the current size gives the fit.
 */

/** Below this nothing is legible even zoomed; a very wide terminal pans instead. */
export const MIN_FONT = 2
export const MAX_FONT = 28
/** A double tap zooms to this (and back to the fit). */
export const READABLE_FONT = 13

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

/** A zoom (× the fit font) the user can have: from the fit up to the largest font. */
export function clampZoom(zoom: number, fitFont: number): number {
  return clamp(zoom, 1, Math.max(1, MAX_FONT / fitFont))
}

/** The zoom at which the text is comfortably readable (1 when the fit already is). */
export function readableZoom(fitFont: number): number {
  return Math.max(1, READABLE_FONT / fitFont)
}
