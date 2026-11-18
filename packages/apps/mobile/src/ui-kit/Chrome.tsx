/**
 * The app's chrome in desktop's look: a project avatar (its colour, its initial;
 * desktop's projects rail), a square icon button with an optional amber count, a pill
 * (desktop's toolbar toggles and the phone's column strip), an amber count badge, and a
 * bottom sheet over a dimmed screen (slides up; drag its grab handle down or tap outside
 * to close; stays above the keyboard).
 *
 * Every control here is at least 44pt to a finger (Apple's minimum), and grows with the
 * user's text size or caps a glyph that must stay in its box.
 */
import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStableCallback } from '../chat/useStableCallback'
import {
  ATTENTION_BADGE,
  AVATAR_TEXT,
  type ChromeColors,
  SCRIM,
  useTheme,
  useThemeVariant
} from '../theme'

/** Apple's minimum touch target. */
const MIN_TOUCH = 44
/** A glyph drawn as text in a fixed box grows at most this much with the text size. */
const GLYPH_MAX_SCALE = 1.3

/**
 * Every `<Modal>`'s `supportedOrientations`: without it React Native lets a modal on an
 * iPhone show in portrait only, so opening any sheet in landscape rotates the app back.
 */
export const MODAL_ORIENTATIONS: NonNullable<
  ComponentProps<typeof Modal>['supportedOrientations']
> = ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']

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
      <Text
        style={[styles.avatarText, { fontSize: size * 0.46 }]}
        maxFontSizeMultiplier={GLYPH_MAX_SCALE}
      >
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
      <Text style={styles.badgeText} maxFontSizeMultiplier={GLYPH_MAX_SCALE}>
        {count}
      </Text>
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
      hitSlop={ICON_BUTTON_SLOP}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge}` : label}
      testID={testID}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
    >
      <Text style={styles.iconGlyph} maxFontSizeMultiplier={GLYPH_MAX_SCALE}>
        {glyph}
      </Text>
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
      hitSlop={PILL_SLOP}
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

/**
 * The sheet's slide runs on the JS thread, like the app's other animations: the native
 * driver needs a native view to attach to, which the component tests do not have.
 */
const NATIVE_DRIVER = false
/** Wider than this (an iPad), a sheet stays this wide, centred at the bottom. */
export const SHEET_MAX_WIDTH = 560
/** Dragging the grab handle down this far (pt), or flicking it down, closes the sheet. */
const DISMISS_DISTANCE = 80
const DISMISS_VELOCITY = 0.8

/** Whether a drag of the grab handle (`dy` pt down, `vy` pt/ms) closes the sheet. Pure. */
export function sheetDismissed(dy: number, vy: number): boolean {
  return dy > DISMISS_DISTANCE || (dy > 0 && vy > DISMISS_VELOCITY)
}

/** Whether the keyboard is up (iOS reports it before it moves: no jump). */
/** Whether the software keyboard is up (from when it starts to move in, iOS). */
export function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false)
  useEffect(() => {
    const ios = Platform.OS === 'ios'
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () =>
      setUp(true)
    )
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setUp(false)
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return up
}

/**
 * A sheet from the bottom over a dimmed screen. It slides up when shown; tapping the
 * dimmed screen or dragging the grab handle down slides it away, then calls `onClose`
 * — which must hide it (`visible` false). A field in it stays above the keyboard.
 */
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
  const variant = useThemeVariant()
  const styles = makeStyles(theme)
  const insets = useSafeAreaInsets()
  const keyboardUp = useKeyboardUp()
  const { height } = useWindowDimensions()
  // How far below its place the sheet is: the window's height = out of sight.
  const [offset] = useState(() => new Animated.Value(Dimensions.get('window').height))
  const closing = useRef(false)

  useEffect(() => {
    if (!visible) return
    closing.current = false
    offset.setValue(Dimensions.get('window').height)
    Animated.timing(offset, {
      toValue: 0,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: NATIVE_DRIVER
    }).start()
  }, [visible, offset])

  const close = useStableCallback(() => {
    if (closing.current) return
    closing.current = true
    Animated.timing(offset, {
      toValue: Dimensions.get('window').height,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: NATIVE_DRIVER
    }).start(() => onClose())
  })

  // The grab handle follows a finger down; let go far or fast enough and the sheet
  // closes, else it springs back.
  const drag = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => g.dy > 4,
        onPanResponderMove: (_e, g) => offset.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_e, g) => {
          if (sheetDismissed(g.dy, g.vy)) close()
          else
            Animated.spring(offset, {
              toValue: 0,
              bounciness: 0,
              useNativeDriver: NATIVE_DRIVER
            }).start()
        },
        onPanResponderTerminate: () =>
          Animated.spring(offset, {
            toValue: 0,
            bounciness: 0,
            useNativeDriver: NATIVE_DRIVER
          }).start()
      }),
    [offset, close]
  )

  const dimOpacity = offset.interpolate({
    inputRange: [0, Math.max(height, 1)],
    outputRange: [1, 0],
    extrapolate: 'clamp'
  })
  const id = (suffix: string) => (testID ? `${testID}-${suffix}` : undefined)
  return (
    <Modal
      testID={id('modal')}
      visible={visible}
      transparent
      animationType="fade"
      supportedOrientations={MODAL_ORIENTATIONS}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        testID={id('keyboard')}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheetRoot}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: dimOpacity }]}>
          <Pressable
            style={[styles.dim, { backgroundColor: SCRIM[variant] }]}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID={id('backdrop')}
          />
        </Animated.View>
        <Animated.View
          testID={testID}
          style={[
            styles.sheet,
            // Over the keyboard the home indicator is hidden: no inset to keep clear.
            { paddingBottom: keyboardUp ? 12 : Math.max(insets.bottom, 12) },
            { transform: [{ translateY: offset }] },
            style
          ]}
        >
          <View testID={id('grab')} style={styles.grabArea} {...drag.panHandlers}>
            <View style={styles.grab} />
          </View>
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

/** Small caps section label (desktop's `uppercase tracking-wide text-muted`). */
export function Caption({ children }: { children: ReactNode }) {
  const styles = makeStyles(useTheme())
  return (
    <Text style={styles.caption} accessibilityRole="header">
      {children}
    </Text>
  )
}

/** A 34pt icon button reaches 44pt to a finger. */
const ICON_BUTTON_SLOP = (MIN_TOUCH - 34) / 2
/** A pill (about 26pt tall) reaches 44pt to a finger, up and down; its neighbours sit beside it. */
const PILL_SLOP = { top: 9, bottom: 9, left: 2, right: 2 }

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    avatar: { alignItems: 'center', justifyContent: 'center' },
    avatarText: { color: AVATAR_TEXT, fontWeight: '700' },
    badge: {
      minWidth: 16,
      minHeight: 16,
      borderRadius: 8,
      paddingHorizontal: 4,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: ATTENTION_BADGE.background
    },
    badgeFloating: { position: 'absolute', top: -6, right: -6 },
    badgeText: { fontSize: 10, fontWeight: '700', color: ATTENTION_BADGE.text },
    iconButton: {
      minWidth: 34,
      minHeight: 34,
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
    dim: { ...StyleSheet.absoluteFill },
    sheet: {
      width: '100%',
      maxWidth: SHEET_MAX_WIDTH,
      alignSelf: 'center',
      maxHeight: '80%',
      backgroundColor: t.popover,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingHorizontal: 16
    },
    // A finger-sized strip around the handle: drag it down to close.
    grabArea: { alignSelf: 'stretch', alignItems: 'center', paddingTop: 8, paddingBottom: 10 },
    grab: {
      width: 36,
      height: 5,
      borderRadius: 3,
      backgroundColor: t.muted
    },
    caption: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: t.mutedForeground
    }
  })
