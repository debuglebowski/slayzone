import { isModalDialogOpen } from './is-modal-dialog-open'

/** Wraps a keydown handler to skip execution when a modal dialog is open. */
export const withModalGuard = (handler: (e: KeyboardEvent) => void) => (e: KeyboardEvent) => {
  if (isModalDialogOpen(e)) return
  handler(e)
}
