const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'

// Every guarded keydown handler asks this for the same keystroke — one per open
// task tab — and a full-document query costs ~1ms on a large DOM. Within one
// dispatch the answer cannot change unless a handler flushes a modal open
// synchronously (React commits state updates after the dispatch), so it is
// computed once per event.
const answerByEvent = new WeakMap<Event, boolean>()

/**
 * Returns true when any Radix UI modal dialog or alert dialog is open in the DOM.
 * Pass the event being handled to share one DOM query across all of its handlers.
 */
export function isModalDialogOpen(event?: Event): boolean {
  if (event) {
    const known = answerByEvent.get(event)
    if (known !== undefined) return known
  }
  const open = document.querySelector(MODAL_SELECTOR) !== null
  if (event) answerByEvent.set(event, open)
  return open
}
