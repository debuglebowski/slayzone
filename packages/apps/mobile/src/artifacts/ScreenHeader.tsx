import type { ReactNode, Ref } from 'react'
import { type HostInstance, Pressable, StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'

/** Apple's minimum touch target. */
const MIN_TOUCH = 44
/** A header button's drawn height; `hitSlop` takes it to {@link MIN_TOUCH}. */
const BUTTON_HEIGHT = 32
const BUTTON_SLOP = (MIN_TOUCH - BUTTON_HEIGHT) / 2

/**
 * A screen's top bar: back (phone), title and subtitle, actions on the right. A long
 * title is cut in the middle, so its end (an artifact's extension) stays readable.
 */
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
  /** The screen Back goes to. */
  backLabel?: string
  actions?: ReactNode
}) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          // The label's line is ~20pt: to 44pt each way.
          hitSlop={{ top: 12, bottom: 12, left: 16, right: 8 }}
          accessibilityRole="button"
          // VoiceOver reads the label, not the chevron.
          accessibilityLabel={backLabel === 'Back' ? 'Back' : `Back to ${backLabel}`}
        >
          <Text style={styles.link}>‹ {backLabel}</Text>
        </Pressable>
      ) : null}
      <View style={styles.titles}>
        <Text
          style={styles.title}
          numberOfLines={1}
          ellipsizeMode="middle"
          accessibilityRole="header"
        >
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

/** A text button for a header or toolbar: drawn compact, touchable at 44pt. */
export function HeaderButton({
  ref,
  label,
  onPress,
  active = false,
  disabled = false,
  accessibilityLabel
}: {
  /** The button's view (an iPad action sheet's anchor). */
  ref?: Ref<HostInstance>
  label: string
  onPress: () => void
  active?: boolean
  disabled?: boolean
  accessibilityLabel?: string
}) {
  const styles = makeStyles(useTheme())
  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      disabled={disabled}
      hitSlop={BUTTON_SLOP}
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
      minHeight: BUTTON_HEIGHT,
      minWidth: BUTTON_HEIGHT,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 10,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    buttonActive: { backgroundColor: t.muted },
    buttonText: { fontSize: 13, color: t.foreground, fontWeight: '500' },
    disabled: { opacity: 0.4 }
  })
