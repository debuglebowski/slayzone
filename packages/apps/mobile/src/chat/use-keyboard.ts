/** The software keyboard: how much of a view it covers (`useKeyboardOverlap`). */
import { type ComponentRef, type RefObject, useEffect, useState } from 'react'
import { Keyboard, type KeyboardEvent, LayoutAnimation, Platform, type View } from 'react-native'
import { useStableCallback } from './useStableCallback'

/** Animates the next layout change with the keyboard's own move (as `KeyboardAvoidingView`). */
function moveWithKeyboard(e: KeyboardEvent): void {
  if (!e.duration || !e.easing) return
  const duration = Math.max(e.duration, 10)
  LayoutAnimation.configureNext({
    duration,
    update: { duration, type: LayoutAnimation.Types[e.easing] ?? 'keyboard' }
  })
}

/**
 * How much of the view `ref` the keyboard covers (pt, iOS; 0 when down): the bottom
 * padding that keeps its content above the keyboard. Unlike `KeyboardAvoidingView` with
 * a fixed offset, it follows the view wherever it sits: measured in the window on every
 * layout (`onLayout`: call it from the view's own) and once the keyboard has moved. Its
 * padding never changes its frame, so measuring cannot feed back.
 */
export function useKeyboardOverlap(ref: RefObject<ComponentRef<typeof View> | null>): {
  bottom: number
  availableHeight: number | null
  onLayout: () => void
} {
  const [frame, setFrame] = useState<{ bottom: number; height: number } | null>(null)
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null)
  const onLayout = useStableCallback(() => {
    ref.current?.measureInWindow((_x: number, y: number, _w: number, height: number) =>
      setFrame((prev) =>
        prev?.bottom === y + height && prev.height === height
          ? prev
          : { bottom: y + height, height }
      )
    )
  })
  useEffect(() => {
    if (Platform.OS !== 'ios') return
    const subs = [
      Keyboard.addListener('keyboardWillShow', (e) => {
        moveWithKeyboard(e)
        // Cross-fade transitions report no position: nothing to avoid (as KeyboardAvoidingView).
        setKeyboardTop(e.endCoordinates.screenY > 0 ? e.endCoordinates.screenY : null)
      }),
      Keyboard.addListener('keyboardWillChangeFrame', (e) => {
        if (e.endCoordinates.screenY > 0) setKeyboardTop(e.endCoordinates.screenY)
      }),
      Keyboard.addListener('keyboardWillHide', (e) => {
        moveWithKeyboard(e)
        setKeyboardTop(null)
      }),
      Keyboard.addListener('keyboardDidShow', onLayout),
      Keyboard.addListener('keyboardDidHide', onLayout)
    ]
    return () => {
      for (const sub of subs) sub.remove()
    }
  }, [onLayout])
  const bottom =
    keyboardTop === null || frame === null ? 0 : Math.max(0, frame.bottom - keyboardTop)
  return { bottom, availableHeight: frame ? Math.max(0, frame.height - bottom) : null, onLayout }
}
