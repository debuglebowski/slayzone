import type { CSSProperties } from 'react'

/** Body text in a chat is `text-sm`: 0.875rem, 14px at the app's 16px root. */
export const CHAT_BODY_TEXT_REM = 0.875
const CHAT_BODY_TEXT_PX = 14

/** The text-* tokens chat uses, at their unscaled rem sizes (theme-css + Tailwind). */
const TEXT_TOKENS_REM = {
  '4xs': 0.5625,
  '3xs': 0.625,
  '2xs': 0.6875,
  xs: 0.75,
  sm: CHAT_BODY_TEXT_REM,
  base: 1,
  lg: 1.125,
  xl: 1.25,
  '2xl': 1.5
} as const

/**
 * Style for a chat panel's root that sizes its text to `fontSize` px: body text
 * (`text-sm`) lands on exactly that size and every other text-* token keeps its
 * proportion to it. Tailwind's text utilities read `var(--text-*)`, so
 * overriding the vars here rescales everything inside the panel; a fixed px
 * class (`text-2xs`) would not, so chat code uses tokens only.
 */
export function chatTypeScaleStyle(fontSize: number): CSSProperties {
  const scale = fontSize / CHAT_BODY_TEXT_PX
  const style: Record<string, string> = { fontSize: `${fontSize}px` }
  for (const [token, rem] of Object.entries(TEXT_TOKENS_REM)) {
    style[`--text-${token}`] = `calc(${rem}rem * ${scale})`
  }
  return style as CSSProperties
}
