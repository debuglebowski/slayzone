/**
 * The task editor's building blocks, in the app's theme: a titled section, a field
 * button (desktop's select trigger), a sheet (iPhone: slides up; iPad: a form sheet),
 * and a one-line prompt in a sheet.
 */
import { type ReactNode, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'

export function Section({
  title,
  action,
  children
}: {
  title: string
  /** A button beside the title. */
  action?: { label: string; onPress: () => void; testID?: string }
  children: ReactNode
}) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.heading}>{title}</Text>
        {action ? (
          <Pressable
            onPress={action.onPress}
            hitSlop={8}
            accessibilityRole="button"
            testID={action.testID}
          >
            <Text style={styles.link}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  )
}

/** A field's value as a button (opens its choices). */
export function FieldButton({
  label,
  onPress,
  testID,
  accessibilityLabel
}: {
  label: string
  onPress?: () => void
  testID?: string
  accessibilityLabel?: string
}) {
  const styles = makeStyles(useTheme())
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={styles.field}
    >
      <Text style={styles.fieldText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

export function Sheet({
  visible,
  title,
  testID,
  onClose,
  closeLabel = 'Cancel',
  children
}: {
  visible: boolean
  title: string
  testID?: string
  onClose: () => void
  closeLabel?: string
  children: ReactNode
}) {
  const styles = makeStyles(useTheme())
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View testID={testID} style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>{closeLabel}</Text>
          </Pressable>
        </View>
        {children}
      </View>
    </Modal>
  )
}

/** A line of text to type, confirmed with `submitLabel`; `validate` says why not. */
export function PromptSheet({
  visible,
  title,
  placeholder,
  submitLabel,
  inputTestID,
  initial = '',
  validate,
  onSubmit,
  onClose
}: {
  visible: boolean
  title: string
  placeholder: string
  submitLabel: string
  inputTestID: string
  initial?: string
  validate?: (text: string) => string | null
  onSubmit: (text: string) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const [text, setText] = useState(initial)
  const [problem, setProblem] = useState<string | null>(null)
  const submit = () => {
    const why = validate?.(text) ?? null
    setProblem(why)
    if (why) return
    onClose()
    onSubmit(text)
  }
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <View style={styles.prompt}>
        <TextInput
          testID={inputTestID}
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={theme.mutedForeground}
          style={styles.input}
          autoFocus
          onSubmitEditing={submit}
        />
        {problem ? <Text style={styles.error}>{problem}</Text> : null}
        <Pressable onPress={submit} accessibilityRole="button" style={styles.primary}>
          <Text style={styles.primaryText}>{submitLabel}</Text>
        </Pressable>
      </View>
    </Sheet>
  )
}

export const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    section: { gap: 8 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    heading: {
      fontSize: 12,
      fontWeight: '600',
      color: t.mutedForeground,
      textTransform: 'uppercase'
    },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    field: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.card
    },
    fieldText: { fontSize: 13, color: t.foreground },
    sheet: { flex: 1, backgroundColor: t.background },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    sheetTitle: { flex: 1, fontSize: 17, fontWeight: '600', color: t.foreground },
    prompt: { padding: 16, gap: 12 },
    input: {
      fontSize: 16,
      color: t.foreground,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.card
    },
    primary: {
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: t.primary
    },
    primaryText: { fontSize: 15, fontWeight: '600', color: t.primaryForeground },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    rowText: { flex: 1, fontSize: 15, color: t.foreground },
    muted: { fontSize: 13, color: t.mutedForeground },
    error: { fontSize: 13, color: t.destructive },
    destructive: { fontSize: 15, color: t.destructive, fontWeight: '500' }
  })
