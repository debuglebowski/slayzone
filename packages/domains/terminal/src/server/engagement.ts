/**
 * Pure helpers for the idle-close "user engaged" signal sourced from panels
 * OTHER than the terminal (the browser WebContentsView, and any future
 * out-of-DOM panel).
 *
 * Why this exists: the idle-close / hibernation gate (`shouldHibernate` in
 * `./state-machine`) only keeps an idle agent warm while `lastUserInteractionAt`
 * stays fresh, and that clock was fed ONLY by the terminal's own DOM listeners
 * (`Terminal.tsx`). Opening & using the browser panel — a separate WebContentsView
 * whose input never reaches the renderer DOM — left the clock stale, so the agent
 * of the task the user was actively browsing got hibernated out from under them.
 *
 * The browser view's `webContents` emits `input-event` in the MAIN process; we
 * translate qualifying events into a throttled `touchPty` on the task's main
 * agent session. These helpers are the pure, testable core of that translation
 * (no Electron imports) so the wiring side stays trivial.
 */

/** Electron `input-event` types that count as genuine user engagement. Mirrors
 *  the terminal's own touch listener (keydown / mousedown / wheel) — deliberately
 *  EXCLUDES passive pointer motion (`mouseMove`/`mouseEnter`/`mouseLeave`) and
 *  key-up, so mere hover can't pin every agent open and burst input still throttles. */
export const ENGAGEMENT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'keyDown',
  'rawKeyDown',
  'mouseDown',
  'mouseWheel'
])

/** True iff this Electron `input.type` should refresh the agent's idle clock. */
export function isEngagementInputType(type: string): boolean {
  return ENGAGEMENT_INPUT_TYPES.has(type)
}

/** Coalesce a burst of qualifying input into at most one touch per window. Matches
 *  the terminal's `TOUCH_THROTTLE_MS` so both engagement sources behave the same. */
export const ENGAGEMENT_TOUCH_THROTTLE_MS = 4000

/** True iff enough time has elapsed since the last reported touch to send another.
 *  `lastReportAt` starts at 0, so the first qualifying event (with a real epoch-ms
 *  `now`) is always far past the window and fires. */
export function shouldReportEngagement(
  lastReportAt: number,
  now: number,
  throttleMs: number = ENGAGEMENT_TOUCH_THROTTLE_MS
): boolean {
  return now - lastReportAt >= throttleMs
}
