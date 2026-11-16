/**
 * The panel page's modified-link bridge (`browser-chrome-preload.ts`): ⌘/ctrl-click a
 * link to open it in the system browser, or to make a task from it.
 *
 * The bridge lives in the page's own world, so the page's script can call it at any
 * time, with any URL. Main honours a call only right after the USER acted in that
 * tab — an input event main itself received, which no page can forge — and each such
 * act allows one call. Opening in the system browser (leaving SlayZone) additionally
 * needs a tab that is the user's own: never one an untrusted caller drives, nor any
 * tab of a remote hub's partition.
 */

/** How long after an input event a bridge call still counts as the user's act
 *  (Chromium's own transient user activation lasts about this long). */
export const GESTURE_WINDOW_MS = 5_000

/** Input event types that are a user's act (not hover / mouse moves / wheel). */
const GESTURE_TYPES = new Set([
  'mouseDown',
  'mouseUp',
  'keyDown',
  'rawKeyDown',
  'char',
  'gestureTap'
])

export type LinkBridgeKind = 'open-external' | 'create-task'

export class UserGestureTracker {
  private readonly last = new Map<number, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = GESTURE_WINDOW_MS
  ) {}

  /** Main saw an input event for this web contents (`input-event`). */
  noteInput(webContentsId: number, type: string): void {
    if (GESTURE_TYPES.has(type)) this.last.set(webContentsId, this.now())
  }

  /** True once per user act: a recent gesture, used up by this call. */
  consume(webContentsId: number): boolean {
    const at = this.last.get(webContentsId)
    if (at === undefined) return false
    this.last.delete(webContentsId)
    return this.now() - at <= this.windowMs
  }

  /** A recent user act in this web contents, WITHOUT using it up (navigation). */
  hasRecent(webContentsId: number): boolean {
    const at = this.last.get(webContentsId)
    return at !== undefined && this.now() - at <= this.windowMs
  }

  forget(webContentsId: number): void {
    this.last.delete(webContentsId)
  }
}

/** Whether to act on one bridge call. Consumes the gesture only when trust allows. */
export function linkBridgeAllowed(
  kind: LinkBridgeKind,
  webContentsId: number,
  ctx: { gestures: UserGestureTracker; untrusted: boolean }
): boolean {
  if (kind === 'open-external' && ctx.untrusted) return false
  return ctx.gestures.consume(webContentsId)
}
