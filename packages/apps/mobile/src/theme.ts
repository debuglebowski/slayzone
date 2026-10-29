import { useColorScheme } from 'react-native'

/**
 * SPIKE: a hand copy of a few `@slayzone/theme-css` tokens (same names), because React
 * Native cannot read that file — it is Tailwind 4 CSS, and its light palette is
 * `oklch()`, which React Native does not parse. The light values below are those
 * `oklch()` values converted to sRGB hex; the dark ones are copied verbatim. A real app
 * generates this module from theme-css instead of copying it.
 */
const light = {
  background: '#ebebeb',
  foreground: '#070707',
  card: '#f5f5f5',
  primary: '#171717',
  primaryForeground: '#fafafa',
  muted: '#e8e8e8',
  mutedForeground: '#555555',
  accent: '#e1e1e1',
  destructive: '#e7000b',
  border: 'rgba(0, 0, 0, 0.22)',
  input: 'rgba(0, 0, 0, 0.25)',
  surface1: '#eeeeee',
  surface2: '#f5f5f5'
}

const dark: typeof light = {
  background: '#141418',
  foreground: '#fafafa',
  card: '#18181b',
  primary: '#e4e4e7',
  primaryForeground: '#18181b',
  muted: '#27272a',
  mutedForeground: '#a1a1aa',
  accent: '#27272a',
  destructive: '#f87171',
  border: 'rgba(255, 255, 255, 0.15)',
  input: 'rgba(255, 255, 255, 0.20)',
  surface1: '#141418',
  surface2: '#18181b'
}

export type Theme = typeof light

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light
}
