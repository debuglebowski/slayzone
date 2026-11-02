import { useWindowDimensions } from 'react-native'

/**
 * Wide enough for desktop's layout (iPad, also in Split View at half width or more):
 * the projects rail, every board column side by side, tasks as tabs, a task's Agent and
 * Details side by side, an artifact beside its list.
 */
export const WIDE_MIN_WIDTH = 700

export function useWide(): boolean {
  return useWindowDimensions().width >= WIDE_MIN_WIDTH
}
