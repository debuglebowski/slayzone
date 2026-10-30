import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'

/** A screen's top bar: back (phone), title and subtitle, actions on the right. */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
  backLabel = 'Back',
  actions
}: {
  title: string
  subtitle?: string | null
  onBack?: () => void
  backLabel?: string
  actions?: ReactNode
}) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>‹ {backLabel}</Text>
        </Pressable>
      ) : null}
      <View style={styles.titles}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  )
}

/** A text button for a header or toolbar. */
export function HeaderButton({
  label,
  onPress,
  active = false,
  disabled = false,
  accessibilityLabel
}: {
  label: string
  onPress: () => void
  active?: boolean
  disabled?: boolean
  accessibilityLabel?: string
}) {
  const styles = makeStyles(useTheme())
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active, disabled }}
      style={[
        styles.button,
        active ? styles.buttonActive : null,
        disabled ? styles.disabled : null
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    titles: { flex: 1 },
    title: { fontSize: 16, fontWeight: '600', color: t.foreground },
    subtitle: { fontSize: 12, color: t.mutedForeground, marginTop: 1 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    button: {
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    buttonActive: { backgroundColor: t.muted },
    buttonText: { fontSize: 13, color: t.foreground, fontWeight: '500' },
    disabled: { opacity: 0.4 }
  })
