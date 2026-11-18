/**
 * Which touches on the terminal are TAPS: one finger, down and up within `TAP_MS`,
 * moving less than `TAP_SLOP_PX` — so a flick that scrolls is never one. Two taps
 * within `DOUBLE_TAP_MS` and `DOUBLE_TAP_SLOP_PX` of each other are a double tap
 * (the terminal's text size toggle); a single tap may open a link. Plain class over
 * a clock, so the rules are tested without a browser (`TerminalDom.tsx` feeds it).
 */

/** A tap lifts within this. */
export const TAP_MS = 250
/** …and moves less than this. */
export const TAP_SLOP_PX = 10
/** The second tap of a double tap comes within this of the first… */
export const DOUBLE_TAP_MS = 300
/** …and lands this close to it. */
export const DOUBLE_TAP_SLOP_PX = 40

export type TapResult = 'tap' | 'double' | null

export class TapTracker {
  private down: { x: number; y: number; at: number } | null = null
  private moved = false
  private lastTap: { x: number; y: number; at: number } | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /** One finger went down at (`x`, `y`). */
  start(x: number, y: number): void {
    this.down = { x, y, at: this.now() }
    this.moved = false
  }

  /** The finger is at (`x`, `y`) now. */
  move(x: number, y: number): void {
    if (!this.down) return
    if (Math.hypot(x - this.down.x, y - this.down.y) >= TAP_SLOP_PX) this.moved = true
  }

  /** Not a tap after all (a second finger: a pinch). */
  cancel(): void {
    this.down = null
    this.lastTap = null
  }

  /** The finger lifted: a tap, the second tap of a double tap, or neither. */
  end(): TapResult {
    const down = this.down
    this.down = null
    const at = this.now()
    if (!down || this.moved || at - down.at >= TAP_MS) {
      this.lastTap = null
      return null
    }
    const last = this.lastTap
    if (
      last &&
      at - last.at < DOUBLE_TAP_MS &&
      Math.hypot(down.x - last.x, down.y - last.y) < DOUBLE_TAP_SLOP_PX
    ) {
      this.lastTap = null
      return 'double'
    }
    this.lastTap = { x: down.x, y: down.y, at }
    return 'tap'
  }
}
