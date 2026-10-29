// <input> types that take typed text. Everything else (checkbox, radio, button,
// range, color, file…) is clicked, not typed into.
const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week'
])

/**
 * Is `el` a field the user is typing into right now — the focus an automatic
 * (not user-initiated) focus move must never take, because blurring it commits or
 * cancels an edit in progress.
 *
 * Narrower than {@link focusOwnsUndoKey}: a terminal's input surface (xterm's
 * helper <textarea>) is not a text field here, nor are read-only or disabled
 * fields and non-text controls.
 */
export function isTextEntryElement(el: Element | null): boolean {
  if (!(el instanceof HTMLElement) || el.closest('.xterm')) return false
  if (el instanceof HTMLInputElement) {
    return (
      TEXT_INPUT_TYPES.has(el.getAttribute('type')?.toLowerCase() ?? '') &&
      !el.readOnly &&
      !el.disabled
    )
  }
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  return el.isContentEditable === true
}
