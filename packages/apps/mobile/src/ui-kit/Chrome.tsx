/**
 * The app's chrome in desktop's look: a project avatar (its colour, its initial;
 * desktop's projects rail), a square icon button with an optional amber count, a pill
 * (desktop's toolbar toggles and the phone's column strip), an amber count badge, and a
 * bottom sheet over a dimmed screen (grab handle; tap outside to close).
 */
import type { ReactNode } from 'react'
import {
  Modal,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ATTENTION_BADGE, AVATAR_TEXT, type ChromeColors, useTheme } from '../theme'

export function ProjectAvatar({
  name,
  color,
  size = 26,
  selected = false,
  badge
}: {
  name: string
  color: string | null | undefined
  size?: number
  selected?: boolean
  badge?: number
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size * 0.3,
          backgroundColor: color || theme.mutedForeground
        },
        selected && { borderWidth: 2, borderColor: theme.foreground }
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.46 }]}>
        {(name.trim()[0] ?? '?').toUpperCase()}
      </Text>
      {badge ? <CountBadge count={badge} floating /> : null}
    </View>
  )
}

export function CountBadge({ count, floating = false }: { count: number; floating?: boolean }) {
  const styles = makeStyles(useTheme())
  return (
    <View style={[styles.badge, floating && styles.badgeFloating]} testID="count-badge">
      <Text style={styles.badgeText}>{count}</Text>
    </View>
  )
}

export function IconButton({
  label,
  glyph,
  badge,
  onPress,
  testID
}: {
  label: string
  glyph: string
  badge?: number
  onPress: () => void
  testID?: string
}) {
  const styles = makeStyles(useTheme())
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge}` : label}
      testID={testID}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
    >
      <Text style={styles.iconGlyph}>{glyph}</Text>
      {badge ? <CountBadge count={badge} floating /> : null}
    </Pressable>
  )
}

export function Pill({
  label,
  active = false,
  onPress,
  testID,
  accessibilityRole = 'button',
  accessibilityLabel,
  children
}: {
  label?: string
  active?: boolean
  onPress?: () => void
  testID?: string
  accessibilityRole?: 'button' | 'tab'
  accessibilityLabel?: string
  children?: ReactNode
}) {
  const styles = makeStyles(useTheme())
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      style={[styles.pill, active && styles.pillActive]}
    >
      {children ?? <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>}
    </Pressable>
  )
}

export function BottomSheet({
  visible,
  onClose,
  testID,
  children,
  style
}: {
  visible: boolean
  onClose: () => void
  testID?: string
  children: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Pressable
          style={styles.dim}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          testID={testID ? `${testID}-backdrop` : undefined}
        />
        <View
          testID={testID}
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }, style]}
        >
          <View style={styles.grab} />
          {children}
        </View>
      </View>
    </Modal>
  )
}

/** Small caps section label (desktop's `uppercase tracking-wide text-muted`). */
export function Caption({ children }: { children: ReactNode }) {
  const styles = makeStyles(useTheme())
  return <Text style={styles.caption}>{children}</Text>
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    avatar: { alignItems: 'center', justifyContent: 'center' },
    avatarText: { color: AVATAR_TEXT, fontWeight: '700' },
    badge: {
      minWidth: 16,
      height: 16,
      borderRadius: 8,
      paddingHorizontal: 4,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: ATTENTION_BADGE.background
    },
    badgeFloating: { position: 'absolute', top: -6, right: -6 },
    badgeText: { fontSize: 10, fontWeight: '700', color: ATTENTION_BADGE.text },
    iconButton: {
      width: 34,
      height: 34,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    pressed: { opacity: 0.6 },
    iconGlyph: { fontSize: 16, color: t.mutedForeground },
    pill: {
      paddingHorizontal: 11,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    pillActive: { borderColor: t.primary, backgroundColor: t.surface3 },
    pillText: { fontSize: 13, color: t.mutedForeground },
    pillTextActive: { color: t.foreground, fontWeight: '600' },
    sheetRoot: { flex: 1, justifyContent: 'flex-end' },
    dim: { ...StyleSheet.absoluteFill, backgroundColor: t.background, opacity: 0.75 },
    sheet: {
      maxHeight: '80%',
      backgroundColor: t.popover,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingHorizontal: 16,
      paddingTop: 8
    },
    grab: {
      alignSelf: 'center',
      width: 36,
      height: 5,
      borderRadius: 3,
      backgroundColor: t.muted,
      marginBottom: 10
    },
    caption: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: t.mutedForeground
    }
  })
