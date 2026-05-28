/**
 * Adaptive paint cadence for the xterm rAF batcher in Terminal.tsx.
 *
 * Background: every `terminal.write` triggers an xterm render frame. Slow-drip
 * output (AI thinking dots, vt-status redraws, progress bars) wakes one frame
 * per chunk → ~60fps repaints for visually-static content. Multiplied across
 * many panes this burns CPU for no UX gain.
 *
 * Strategy: when the time since the last keystroke OR PTY data arrival exceeds
 * SLOW_DRIP_THRESHOLD_MS, the batcher skips up to THROTTLE_SKIP_FRAMES rAFs
 * before painting — yielding ~20fps at a 60Hz display. Two escape hatches:
 *   1. A keystroke or fresh data arrival bumps `lastActivityTime` so the very
 *      next decision sees the terminal as active and paints full-rate.
 *   2. Heavy output disengages the throttle: an EMA over flush byte counts OR
 *      a single oversized chunk both flip `flooding` true, painting every frame
 *      so build logs stay smooth.
 *
 * fps controls PAINT rate only. xterm always parses 100% of incoming bytes
 * into its buffer model — a skipped frame just defers the visible repaint;
 * the eventual flush draws the latest buffer state in one call.
 */

export const SLOW_DRIP_THRESHOLD_MS = 500
export const FLOOD_BYTES_THRESHOLD = 4096
export const FLOOD_EMA_ALPHA = 0.3
export const THROTTLE_SKIP_FRAMES = 2 // skip 2 of every 3 rAFs at 60Hz → ~20fps

export interface ThrottleState {
  lastActivityTime: number
  floodScore: number
  skipCounter: number
}

export interface ThrottleDecision {
  skip: boolean
  nextSkipCounter: number
  nextFloodScore: number
}

export interface ThrottleOptions {
  slowDripThresholdMs: number
  floodBytesThreshold: number
  floodEmaAlpha: number
  throttleSkipFrames: number
}

export const DEFAULT_THROTTLE_OPTIONS: ThrottleOptions = {
  slowDripThresholdMs: SLOW_DRIP_THRESHOLD_MS,
  floodBytesThreshold: FLOOD_BYTES_THRESHOLD,
  floodEmaAlpha: FLOOD_EMA_ALPHA,
  throttleSkipFrames: THROTTLE_SKIP_FRAMES
}

/**
 * Decide whether the current flush should skip or paint. Pure — caller owns
 * the state refs and applies the returned `next*` values after acting on
 * `skip`. Flood detection is OR of EMA and current-flush bytes so a single
 * big chunk disengages the throttle on the same frame it arrives, with no
 * EMA warmup lag at burst onset.
 */
export function decideThrottle(
  now: number,
  bytes: number,
  state: ThrottleState,
  opts: ThrottleOptions
): ThrottleDecision {
  const nextFloodScore =
    (1 - opts.floodEmaAlpha) * state.floodScore + opts.floodEmaAlpha * bytes
  const flooding =
    nextFloodScore > opts.floodBytesThreshold || bytes > opts.floodBytesThreshold
  const slowDrip = now - state.lastActivityTime > opts.slowDripThresholdMs
  if (slowDrip && !flooding && state.skipCounter < opts.throttleSkipFrames) {
    return { skip: true, nextSkipCounter: state.skipCounter + 1, nextFloodScore }
  }
  return { skip: false, nextSkipCounter: 0, nextFloodScore }
}
