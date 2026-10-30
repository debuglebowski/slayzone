import { StatusBar } from 'expo-status-bar'
import type { ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme, useThemeVariant } from './theme'

/** The window: safe-area insets in the theme's background, a status bar readable on it. */
export function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme()
  const variant = useThemeVariant()
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]}>
      <StatusBar style={variant === 'dark' ? 'light' : 'dark'} />
      {children}
    </SafeAreaView>
  )
}

export function Loading() {
  const theme = useTheme()
  return (
    <View style={styles.center}>
      <ActivityIndicator color={theme.foreground} />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' }
})
