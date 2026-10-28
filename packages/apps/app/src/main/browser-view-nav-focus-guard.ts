/**
 * Navigation focus-steal guard for one browser WebContentsView.
 *
 * Chromium hands keyboard focus to a WCV when its main frame commits a
 * navigation — reload included, and even while the view is hidden (reproduced
 * on Electron 41; flaky because it requires the window to be OS-key). A panel
 * must only gain focus from deliberate user action, never because its page
 * reloaded under it (e.g. a vite full-reload triggered by an agent's file edit)
 * while the user types in a terminal. The focus owner is snapshotted when a load
 * starts; if focus lands on the view during the load without real user input in
 * it or an explicit focus request, it is handed straight back.
 *
 * A real click focuses the view BEFORE its mouseDown `input-event` fires
 * (measured on macOS: focus, then mouseDown ~1ms later — AppKit makes the view
 * first responder before dispatching mouseDown). So a click into a still-loading
 * page first looks like a steal. The hand-back stays immediate (no keystrokes
 * leak into the page), and a mouseDown arriving shortly after it reclaims focus
 * for the view — the click wins.
 */

/** A mouseDown/keyDown this soon after a hand-back reclaims focus for the view. */
export const NAV_FOCUS_RECLAIM_MS = 100
/** Input or explicit focus this soon before a focus gain makes it genuine. */
const GENUINE_WINDOW_MS = 1000
/** Guard stays armed this long past load end — the grab can land just after. */
const POST_LOAD_GRACE_MS = 300

export interface FocusOwner {
  id: number
  isDestroyed(): boolean
}

export interface NavFocusGuardDeps<O extends FocusOwner> {
  now(): number
  /** The view's own webContents id. */
  viewId: number
  /** Last explicit (app-requested) focus of this view, ms epoch; 0 if none. */
  explicitFocusAt(): number
  /** Genuine focus gain — glow + engagement. */
  onGenuine(): void
  /** Stolen focus — restore it to the snapshotted owner. */
  onStolen(owner: O): void
  /** The user clicked/typed in the view right after a hand-back — focus it. */
  onReclaim(): void
}

export class NavFocusGuard<O extends FocusOwner> {
  private owner: O | null = null
  private guardUntil = 0 // Infinity while loading, then a short post-load grace
  private lastRealUserInputAt = 0
  private handedBackAt = 0

  constructor(private readonly deps: NavFocusGuardDeps<O>) {}

  /** Main-frame, cross-document navigation started; `focused` = current focus owner. */
  navigationStarted(focused: O | null): void {
    this.owner = focused && focused.id !== this.deps.viewId ? focused : null
    this.guardUntil = this.owner ? Infinity : 0
  }

  loadStopped(): void {
    if (this.guardUntil === Infinity) this.guardUntil = this.deps.now() + POST_LOAD_GRACE_MS
  }

  /** Real user input (mouseDown / keyDown) inside the view. */
  userInput(): void {
    const now = this.deps.now()
    this.lastRealUserInputAt = now
    if (this.handedBackAt && now - this.handedBackAt < NAV_FOCUS_RECLAIM_MS) {
      this.handedBackAt = 0
      this.deps.onReclaim() // guard is disarmed, so the re-focus reads as genuine
    }
  }

  focused(): void {
    const { deps } = this
    const now = deps.now()
    const guardActive = this.guardUntil === Infinity || now < this.guardUntil
    const owner = this.owner
    const genuine =
      now - this.lastRealUserInputAt < GENUINE_WINDOW_MS ||
      now - deps.explicitFocusAt() < GENUINE_WINDOW_MS
    if (!guardActive || !owner || owner.isDestroyed() || genuine) {
      deps.onGenuine()
      return
    }
    this.guardUntil = 0 // one restore per navigation — never fight the user
    this.handedBackAt = now
    deps.onStolen(owner)
  }
}
