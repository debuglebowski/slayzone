/**
 * Long text on its own screen: a tool's whole output, or a message to select from —
 * scrolls both ways (long lines are not wrapped when `mono`), selectable (iOS's own
 * selection: Copy, Look Up, …), with Copy / Share (the share sheet) and Done.
 */
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ChromeColors } from '../theme'
import { MODAL_ORIENTATIONS } from '../ui-kit/Chrome'
import { copyText } from './message-text'
import { MONO, useThemedStyles } from './styles'

export function TextViewer({
  title,
  text,
  mono = false,
  visible,
  onClose
}: {
  title: string
  text: string
  /** Code / tool output: monospace, lines not wrapped. */
  mono?: boolean
  visible: boolean
  onClose: () => void
}) {
  const { s } = useThemedStyles(makeStyles)
  const insets = useSafeAreaInsets()
  const body = (
    <Text style={mono ? s.mono : s.text} selectable>
      {text}
    </Text>
  )
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      supportedOrientations={MODAL_ORIENTATIONS}
      onRequestClose={onClose}
    >
      <View
        style={[s.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        testID="text-viewer"
      >
        <View style={s.header}>
          <Text style={s.title} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          <Pressable
            onPress={() => copyText(text)}
            accessibilityRole="button"
            accessibilityLabel="Copy"
            hitSlop={8}
            style={s.action}
          >
            <Text style={s.actionText}>Copy</Text>
          </Pressable>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={8} style={s.action}>
            <Text style={[s.actionText, s.done]}>Done</Text>
          </Pressable>
        </View>
        <ScrollView style={s.flex} contentContainerStyle={s.pad}>
          {mono ? <ScrollView horizontal>{body}</ScrollView> : body}
        </ScrollView>
      </View>
    </Modal>
  )
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    flex: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: { flex: 1, color: t.foreground, fontSize: 16, fontWeight: '700' },
    action: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
    actionText: { color: t.primary, fontSize: 16 },
    done: { fontWeight: '700' },
    pad: { padding: 14 },
    text: { color: t.foreground, fontSize: 15, lineHeight: 21 },
    mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: t.foreground }
  })
}
