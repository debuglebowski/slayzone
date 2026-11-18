/**
 * iOS 26's Liquid Glass (`expo-glass-effect`) for the app's floating chrome — the task
 * page's back button, title, status island, tab bar and composer — drawn in the theme's
 * variant, not the device's, so it reads on the theme's background whichever the device
 * uses. Before iOS 26 (no Liquid Glass), the theme's card colour with a hairline border
 * stands in, so the chrome still floats visibly over the content.
 */
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import type { ReactNode } from 'react'
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'
import { type ChromeColors, useTheme, useThemeVariant } from '../theme'

/** Whether this iOS draws Liquid Glass (asked once: it cannot change while the app runs). */
const LIQUID_GLASS = isLiquidGlassAvailable()

export function Glass({
  style,
  interactive = false,
  testID,
  children
}: {
  style?: StyleProp<ViewStyle>
  /** Reacts to touch (the glass flexes under a finger): set on buttons. */
  interactive?: boolean
  testID?: string
  children?: ReactNode
}) {
  const theme = useTheme()
  const variant = useThemeVariant()
  if (LIQUID_GLASS) {
    return (
      <GlassView
        glassEffectStyle="regular"
        isInteractive={interactive}
        colorScheme={variant}
        style={style}
        testID={testID}
      >
        {children}
      </GlassView>
    )
  }
  return (
    <View style={[makeStyles(theme).fallback, style]} testID={testID}>
      {children}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    fallback: {
      backgroundColor: t.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    }
  })
