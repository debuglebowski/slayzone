/**
 * Reason-counting for a webContents' CDP debugger session.
 *
 * A webContents has exactly one debugger session, but more than one feature
 * now wants it held open: the agent lock (`Input.setIgnoreInputEvents`) and a
 * forced color scheme (`Emulation.setEmulatedMedia`). Both are session-bound —
 * detaching drops every override on that session, not just the one whose
 * feature was switched off.
 *
 * Tracking a single "did I attach this" boolean, as the lock used to, means
 * unlocking detaches while a theme override is still meant to be in force and
 * silently reverts it. So attach on the first holder, detach only when the
 * last one leaves, and never detach a session someone else attached.
 *
 * Pure and Electron-free so the transitions can be unit-tested; the caller
 * performs the actual attach/detach and re-sends the overrides.
 */

export type DebuggerHolder = 'lock' | 'theme'

export class DebuggerHolders {
  private readonly holders = new Set<DebuggerHolder>()

  /**
   * Whether *we* attached the session. A session attached by something else
   * (DevTools, another feature) is borrowed, not owned — we use it but must
   * not detach it.
   */
  private ownsAttach = false

  /** Register interest. Returns true when the caller must attach now. */
  acquire(holder: DebuggerHolder, alreadyAttached: boolean): boolean {
    const wasEmpty = this.holders.size === 0
    this.holders.add(holder)
    if (!wasEmpty) return false
    if (alreadyAttached) {
      this.ownsAttach = false
      return false
    }
    this.ownsAttach = true
    return true
  }

  /** Drop interest. Returns true when the caller must detach now. */
  release(holder: DebuggerHolder): boolean {
    if (!this.holders.delete(holder)) return false
    if (this.holders.size > 0) return false
    const shouldDetach = this.ownsAttach
    this.ownsAttach = false
    return shouldDetach
  }

  /**
   * The session went away underneath us — DevTools took it, or the renderer
   * died. Forget everything; whoever still wants an override re-acquires.
   */
  reset(): void {
    this.holders.clear()
    this.ownsAttach = false
  }

  has(holder: DebuggerHolder): boolean {
    return this.holders.has(holder)
  }

  get size(): number {
    return this.holders.size
  }
}
