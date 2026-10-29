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
   * focus() no-ops — the claim then survives for the next activation. An attach
   * that lands while the user is typing elsewhere drops the claim instead.
   */
  paneAttached: (api: PaneFocusApi) => void
}

/** Focus is in a field the user types into — an async focus must never take it. */
export function isEditingElement(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || el.matches('input, textarea, select')
}

/**
 * Focus handoff between tab activation and async pane attach. Both sides race:
 * activation can fire before the pane exists, and the pane can attach before
 * the view is interactive. `focusLanded` (checked synchronously after every
 * focus attempt) decides which side completes the handoff; the loser leaves
 * the claim in place for the other.
 *
 * The attach side is asynchronous — a slow spawn attaches seconds after the
 * activation — so by then the user may be typing somewhere else (an inline
 * rename in the sidebar or artifacts panel). `typingElsewhere` vetoes it: taking
 * focus there would blur the field mid-edit, and blur commits those editors.
 */
export function createFocusHandoff(
  focusLanded: () => boolean,
  initialClaim: boolean,
  typingElsewhere: () => boolean = () => false
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
      if (typingElsewhere()) {
        // The user moved on since the claim; the next activation claims anew.
        pending = false
        return
      }
      api.focus()
      if (focusLanded()) pending = false
    }
  }
}

export interface ContainerFocusHandoff extends FocusHandoff {
  /** The element focus must land inside — pass as the container's callback ref. */
  setContainer: (el: Element | null) => void
}

/**
 * A focus handoff that owns its container: focus counts as landed when the
 * active element is inside it. Container-contains is the right granularity
 * because panes are opaque (xterm textarea vs chat input).
 */
export function createContainerFocusHandoff(initialClaim: boolean): ContainerFocusHandoff {
  let container: Element | null = null
  const handoff = createFocusHandoff(
    () => !!container?.contains(document.activeElement),
    initialClaim,
    () => isEditingElement(document.activeElement) && !container?.contains(document.activeElement)
  )
  return {
    ...handoff,
    setContainer(el) {
      container = el
    }
  }
}
