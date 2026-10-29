import { isTextEntryElement } from '@slayzone/ui'

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
   * doesn't land, the claim is kept for the pane that attaches later. An
   * activation that finds the user typing somewhere else drops the claim
   * instead: opening a task is a transition, so the swap can commit after a
   * later edit began (a double-click's first click opens the task, the
   * double-click starts an inline rename).
   */
  activate: (focus: () => void) => void
  /**
   * A pane's xterm attached: complete a matching claim. The attach can fire
   * while the tab view is still inert/invisible (deferred tab swap) where
   * focus() no-ops — the claim then survives for the next activation. An attach
   * that finds the user typing somewhere else since the claim drops it instead.
   */
  paneAttached: (api: PaneFocusApi) => void
}

/** Where focus is, as the handoff needs to see it. */
export interface FocusTracker {
  /** The element holding focus now. */
  current: () => Element | null
  /**
   * Focus on `el` is the user typing in a field outside the handoff's panes. A
   * field inside an inert subtree (a hidden tab) is not: nobody can type there.
   */
  isTypingElsewhere: (el: Element | null) => boolean
}

/**
 * Focus handoff between tab activation and async pane attach. Both sides race:
 * activation can fire before the pane exists, and the pane can attach before
 * the view is interactive. `focusLanded` (checked synchronously after every
 * focus attempt) decides which side completes the handoff; the loser leaves
 * the claim in place for the other.
 *
 * The attach side is asynchronous — a slow spawn attaches seconds after the
 * claim — so by then the user may have started typing somewhere else (an inline
 * rename in the sidebar or artifacts panel), and taking focus would blur the
 * field mid-edit (blur commits those editors). With a `tracker`, an attach drops
 * the claim when focus has MOVED into such a field since the claim. A claim made
 * while already in one (Cmd+T from the description editor) still completes: that
 * request came after the typing, so it is what the user wants now.
 *
 * Activation is asynchronous too — the tab swap is a React transition and
 * commits after any discrete input the user gave meanwhile — so it never takes
 * focus from such a field at all. A field in the tab being hidden by the same
 * swap is inert by then and doesn't count.
 */
export function createFocusHandoff(
  focusLanded: () => boolean,
  initialClaim: boolean,
  tracker?: FocusTracker
): FocusHandoff {
  let pending: string | boolean = initialClaim
  // Focus when the outstanding claim was made, to tell "moved on" from "was there".
  let claimedFrom = tracker?.current() ?? null
  const markClaim = (): void => {
    claimedFrom = tracker?.current() ?? null
  }
  return {
    claim(target) {
      pending = target
      markClaim()
    },
    activate(focus) {
      if (tracker?.isTypingElsewhere(tracker.current())) {
        pending = false
        return
      }
      focus()
      // A landed activation also clears any outstanding claim: the terminal
      // has focus, so a later attach must not steal it.
      if (focusLanded()) {
        pending = false
      } else {
        pending = true
        markClaim()
      }
    },
    paneAttached(api) {
      if (pending !== true && pending !== api.sessionId) return
      const now = tracker?.current() ?? null
      if (tracker && now !== claimedFrom && tracker.isTypingElsewhere(now)) {
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
    {
      current: () => document.activeElement,
      isTypingElsewhere: (el) =>
        isTextEntryElement(el) && !container?.contains(el) && !el?.closest('[inert]')
    }
  )
  return {
    ...handoff,
    setContainer(el) {
      container = el
    }
  }
}
