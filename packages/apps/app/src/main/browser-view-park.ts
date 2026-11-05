/**
 * Native sizing of parked WebContentsViews (bounds fully outside their window,
 * e.g. the active browser tab of a background task, parked at -20000,-20000).
 *
 * Measured on Electron 44 / macOS (2026-11-04), live dev app:
 * - A view fully outside its window has its native host hidden, so
 *   `setBounds` only moves the JS-side rect: the page keeps its old viewport.
 *   A view created at 1x1 and parked before ever being on screen stayed at
 *   1x1 forever, and agents driving it got empty dashboards.
 * - The native frame IS taken from the bounds when the view is attached, so a
 *   parked size change is applied as detach -> setBounds -> attach.
 * - The page only picks up a new size while its widget is not hidden, and a
 *   parked view is occluded, so hidden. Parked visible views therefore run
 *   with background throttling off (the manager's job), which also keeps them
 *   genuinely live: rAF-driven charts draw, background video keeps playing.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** True when no pixel of `rect` falls inside a window content area of `content` size. */
export function isOutsideWindow(rect: Rect, content: Size): boolean {
  return (
    rect.x + rect.width <= 0 ||
    rect.y + rect.height <= 0 ||
    rect.x >= content.width ||
    rect.y >= content.height
  )
}

export type NativeBoundsPlan = 'set' | 'reattach'

/**
 * How to push `rect` to a view's native host.
 * - `set`: plain setBounds. Enough when the view is detached (the next attach
 *   applies it), when it overlaps the window, or when only the position moves.
 * - `reattach`: an attached view parked outside the window whose page size
 *   differs from `rect` — only an attach applies the new size.
 */
export function planNativeBounds(
  rect: Rect,
  state: { attached: boolean; outside: boolean; nativeSize: Size | null }
): NativeBoundsPlan {
  if (!state.attached || !state.outside) return 'set'
  const n = state.nativeSize
  if (n && n.width === rect.width && n.height === rect.height) return 'set'
  return 'reattach'
}
