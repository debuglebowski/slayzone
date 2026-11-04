/**
 * A finger dragging over the phone's terminal, as the program gets it. xterm.js turns
 * a touch scroll into PROGRAM INPUT when the program asks for the mouse (wheel
 * reports) or has no scrollback (the alternate screen: arrow keys) — but the phone's
 * terminal is read-only (`disableStdin`, see `xterm-view.ts`), so xterm drops that
 * input and a full-screen agent (Claude Code: alternate screen + mouse) cannot be
 * scrolled. The phone sends those bytes itself, through the same path as the key
 * bar. This file is xterm's rule (6.1 `_handleTouchChange`) and its wheel encodings
 * (`CoreMouseService`: DEFAULT, SGR, SGR_PIXELS), so the program cannot tell the
 * phone from xterm.
 */
import { arrowKey } from '@slayzone/terminal-contracts'

/** How the program asked for mouse reports (DECSET 1006 / 1016; neither = X10 bytes). */
export type MouseEncoding = 'default' | 'sgr' | 'sgr-pixels'

/** xterm's `modes.mouseTrackingMode`. */
export type MouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

/** What decides where a touch scroll goes. */
export interface ScrollModes {
  mouseTracking: MouseTracking
  mouseEncoding: MouseEncoding
  /** The alternate screen is active (it has no scrollback). */
  alternateScreen: boolean
  applicationCursorKeys: boolean
}

/** Where on the terminal the finger is: 1-based cell, and pixels inside the screen. */
export interface ScrollPoint {
  col: number
  row: number
  x: number
  y: number
}

/** X10 tracking reports button presses only; the others include the wheel. */
const reportsWheel = (tracking: MouseTracking): boolean =>
  tracking === 'vt200' || tracking === 'drag' || tracking === 'any'

/** The program, not the terminal's scrollback, takes this touch scroll. */
export function scrollGoesToProgram(modes: ScrollModes): boolean {
  return reportsWheel(modes.mouseTracking) || modes.alternateScreen
}

/** One wheel notch (`up`: towards older content) at `at`, as xterm encodes it. */
export function wheelBytes(up: boolean, at: ScrollPoint, encoding: MouseEncoding): string {
  const button = up ? 64 : 65
  if (encoding === 'sgr') return `\x1b[<${button};${at.col};${at.row}M`
  if (encoding === 'sgr-pixels') return `\x1b[<${button};${at.x};${at.y}M`
  const bytes = [button + 32, at.col + 32, at.row + 32]
  // X10 bytes cannot carry a cell past 223: xterm sends nothing there.
  if (bytes.some((b) => b > 255)) return ''
  return `\x1b[M${String.fromCharCode(...bytes)}`
}

/**
 * The bytes `lines` of touch scroll send the program (negative: the finger moved
 * down, towards older content). Wheel notches if the program reports the wheel,
 * else arrow keys — xterm's order.
 */
export function touchScrollBytes(lines: number, modes: ScrollModes, at: ScrollPoint): string {
  const up = lines < 0
  const one = reportsWheel(modes.mouseTracking)
    ? wheelBytes(up, at, modes.mouseEncoding)
    : arrowKey(up ? 'up' : 'down', modes.applicationCursorKeys)
  return one.repeat(Math.abs(lines))
}

/** Pixels dragged → whole lines, carrying the remainder (xterm's accumulator). */
export class ScrollAccumulator {
  private pixels = 0

  reset(): void {
    this.pixels = 0
  }

  /** `dy`: how far the finger moved down since the last call. */
  lines(dy: number, cellHeight: number): number {
    if (cellHeight <= 0) return 0
    this.pixels -= dy
    const lines = Math.trunc(this.pixels / cellHeight) || 0 // never -0
    this.pixels -= lines * cellHeight
    return lines
  }
}
