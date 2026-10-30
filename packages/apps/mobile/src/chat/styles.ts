import { useMemo } from 'react'
import { type ChromeColors, useTheme } from '../theme'

/** A component's styles from the theme, rebuilt only when the theme changes. */
export function useThemedStyles<T>(make: (t: ChromeColors) => T): { s: T; theme: ChromeColors } {
  const theme = useTheme()
  const s = useMemo(() => make(theme), [make, theme])
  return { s, theme }
}

export const MONO = 'Menlo'
