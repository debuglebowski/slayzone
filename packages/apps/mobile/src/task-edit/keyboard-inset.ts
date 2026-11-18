/**
 * Room for the keyboard at the bottom of a view that fills a sheet (a form sheet sits
 * below the screen's top, so `KeyboardAvoidingView`, which measures within its parent,
 * gets it wrong): the view is measured in the window when the keyboard moves, and the
 * part the keyboard covers comes back as `inset` (pad the view's bottom by it).
 */
import { useEffect, useState } from 'react'
import { type HostInstance, Keyboard } from 'react-native'

/** How far a keyboard whose top is at `keyboardTop` (window y; null = none) covers the view. */
export function keyboardOverlap(
  view: { y: number; height: number },
  keyboardTop: number | null
): number {
  if (keyboardTop === null) return 0
  return Math.max(0, Math.round(view.y + view.height - keyboardTop))
}

export function useKeyboardInset(): {
  /** Pass as the view's `ref`. */
  attach: (node: HostInstance | null) => void
  inset: number
} {
  // State, not a ref: the view is read in the keyboard listener only, and a state
  // setter is a stable callback ref.
  const [node, setNode] = useState<HostInstance | null>(null)
  const [inset, setInset] = useState(0)
  useEffect(() => {
    if (!node) return
    const moved = Keyboard.addListener('keyboardWillChangeFrame', (e) => {
      // The view fills its sheet: padding its bottom doesn't change where its frame ends.
      node.measureInWindow((_x, y, _width, height) =>
        setInset(keyboardOverlap({ y, height }, e.endCoordinates.screenY))
      )
    })
    const hidden = Keyboard.addListener('keyboardWillHide', () => setInset(0))
    return () => {
      moved.remove()
      hidden.remove()
    }
  }, [node])
  return { attach: setNode, inset }
}
