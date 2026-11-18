import { Platform, useWindowDimensions } from 'react-native'

/**
 * Wide enough for desktop's layout on an iPad (also in Split View at half width or
 * more): the projects rail, every board column side by side, tasks as tabs, a task's
 * Agent and Details side by side, an artifact beside its list.
 */
export const WIDE_MIN_WIDTH = 700

/**
 * Desktop's layout: an iPad window at least `WIDE_MIN_WIDTH` wide. An iPhone is never
 * wide — not in landscape either: rotating it must not turn an open task into a tab or
 * move the artifact viewer beside its list.
 */
export function isWideWindow(width: number): boolean {
  return Platform.OS === 'ios' && Platform.isPad && width >= WIDE_MIN_WIDTH
}

export function useWide(): boolean {
  return isWideWindow(useWindowDimensions().width)
}
