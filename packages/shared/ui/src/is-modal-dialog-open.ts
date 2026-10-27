/**
 * Matches the overlay of an open modal surface: our Dialog, AlertDialog and Sheet
 * wrappers (CommandDialog and every app dialog build on these).
 *
 * The overlay is the modal signal, not the content: Radix renders a Dialog's Overlay only
 * when the dialog is modal (AlertDialog always is), and no non-modal surface — Popover,
 * whose content is itself `role="dialog"`, DropdownMenu, Select, ContextMenu, Tooltip, a
 * `modal={false}` Dialog or Sheet — renders one. Radix sets no `aria-modal` (it hides the
 * outside with `aria-hidden` instead), and its other modal mechanics (body
 * `pointer-events: none`, scroll lock, `aria-hidden` siblings) are shared with modal menus
 * and Select, so neither can tell a dialog from a menu. `data-state="open"` drops a closing
 * overlay still mounted for its exit animation.
 */
export const MODAL_DIALOG_SELECTOR = [
  '[data-slot="dialog-overlay"][data-state="open"]',
  '[data-slot="alert-dialog-overlay"][data-state="open"]',
  '[data-slot="sheet-overlay"][data-state="open"]'
].join(', ')

/**
 * An open dialog inside a hidden `<Activity>` (a task panel of a background tab) stays
 * in the DOM, but React hides its portal with `display: none` and tears down its modal
 * effects (focus trap, scroll lock, outside-pointer block): it is not modal until shown.
 * Engines without `checkVisibility` (Safari < 17.4, Firefox < 125) count every match.
 */
function isRendered(overlay: Element): boolean {
  return typeof overlay.checkVisibility === 'function' ? overlay.checkVisibility() : true
}

// Every guarded keydown handler asks this for the same keystroke — one per open
// task tab — and a full-document query costs ~1ms on a large DOM, so it is computed
// once per event. The answer is the one at the event's first check, i.e. when the key
// was pressed: a handler that opens a modal, or a modal that closes on this very key
// (Radix closes on Escape before bubble-phase handlers run), does not change it for the
// rest of the dispatch.
const answerByEvent = new WeakMap<Event, boolean>()

/**
 * Returns true when a modal Dialog, AlertDialog or Sheet is open.
 * Pass the event being handled to share one DOM query across all of its handlers.
 */
export function isModalDialogOpen(event?: Event): boolean {
  if (event) {
    const known = answerByEvent.get(event)
    if (known !== undefined) return known
  }
  let open = false
  for (const overlay of document.querySelectorAll(MODAL_DIALOG_SELECTOR)) {
    if (isRendered(overlay)) {
      open = true
      break
    }
  }
  if (event) answerByEvent.set(event, open)
  return open
}
