import { useState, type ReactNode } from 'react'

/**
 * Defers mounting `children` until `open` is first true, then keeps them
 * mounted for good.
 *
 * For controlled dialogs rendered per list item (one per kanban card, one per
 * open task tab): a closed Radix Dialog still mounts its root, providers,
 * hooks and subscriptions, so N never-opened dialogs cost N full subtrees.
 * Latching instead of unmounting on close keeps Radix's exit animation, focus
 * return and the dialog's own state across reopen exactly as an always-mounted
 * dialog behaves — only the never-opened case changes, and it renders nothing.
 */
export function MountWhenOpened({
  open,
  children
}: {
  open: boolean
  children: ReactNode
}): ReactNode {
  const [opened, setOpened] = useState(open)
  // Derived-state update during render: React re-renders this component
  // immediately, before commit, so the first open never paints a frame late.
  if (open && !opened) setOpened(true)
  return open || opened ? children : null
}
