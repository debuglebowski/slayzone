import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'

export interface Choice {
  key: string
  label: string
  /** A second line (e.g. why a computer can't take work now). */
  detail?: string
}

/**
 * Pick one of a few options in a sheet (iPhone: slides up full height; iPad: a form
 * sheet): the app's stand-in for desktop's select menus. Choosing closes it.
 */
export function ChoiceSheet({
  visible,
  title,
  choices,
  selectedKey,
  onChoose,
  onClose
}: {
  visible: boolean
  title: string
  choices: readonly Choice[]
  selectedKey: string | null
  onChoose: (key: string) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View testID="choice-sheet" style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView>
          {choices.map((choice) => {
            const selected = choice.key === selectedKey
            return (
              <Pressable
                key={choice.key}
                testID={`choice-${choice.key}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[styles.row, selected && styles.rowSelected]}
                onPress={() => {
                  onClose()
                  onChoose(choice.key)
                }}
              >
                <View style={styles.rowText}>
                  <Text style={[styles.label, selected && styles.labelSelected]}>
                    {choice.label}
                  </Text>
                  {choice.detail ? <Text style={styles.detail}>{choice.detail}</Text> : null}
                </View>
                {selected ? <Text style={styles.labelSelected}>✓</Text> : null}
              </Pressable>
            )
          })}
        </ScrollView>
      </View>
    </Modal>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    sheet: { flex: 1, backgroundColor: t.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: { flex: 1, fontSize: 17, fontWeight: '600', color: t.foreground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    rowSelected: { backgroundColor: t.accent },
    rowText: { flex: 1 },
    label: { fontSize: 16, color: t.foreground },
    labelSelected: { color: t.accentForeground, fontWeight: '600' },
    detail: { fontSize: 12, color: t.mutedForeground, marginTop: 2 }
  })
