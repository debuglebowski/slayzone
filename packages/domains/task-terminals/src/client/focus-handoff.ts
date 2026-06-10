export interface PaneFocusApi {
  sessionId: string
  focus: () => void
}

export interface FocusHandoff {
  /** Mark the next attaching pane (or a specific session's pane) as the focus target. */
  claim: (target: string | true) => void
  /**
   * Tab/cell became active: try focusing now. focus() silently no-ops while
   * the pane is unmounted, lazy-loading, or torn down — so when the focus
   * doesn't land, the claim is kept for the pane that attaches later.
   */
  activate: (focus: () => void) => void
  /**
   * A pane's xterm attached: complete a matching claim. The attach can fire
   * while the tab view is still inert/invisible (deferred tab swap) where
   * focus() no-ops — the claim then survives for the next activation.
   */
  paneAttached: (api: PaneFocusApi) => void
}

/**
 * Focus handoff between tab activation and async pane attach. Both sides race:
 * activation can fire before the pane exists, and the pane can attach before
 * the view is interactive. `focusLanded` (checked synchronously after every
 * focus attempt) decides which side completes the handoff; the loser leaves
 * the claim in place for the other.
 */
export function createFocusHandoff(
  focusLanded: () => boolean,
  initialClaim: boolean
): FocusHandoff {
  let pending: string | boolean = initialClaim
  return {
    claim(target) {
      pending = target
    },
    activate(focus) {
      focus()
      // A landed activation also clears any outstanding claim: the terminal
      // has focus, so a later attach must not steal it.
      pending = focusLanded() ? false : true
    },
    paneAttached(api) {
      if (pending !== true && pending !== api.sessionId) return
      api.focus()
      if (focusLanded()) pending = false
    }
  }
}
