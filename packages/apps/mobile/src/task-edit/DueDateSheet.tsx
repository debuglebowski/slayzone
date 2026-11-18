/**
 * Choosing a due date, in one sheet: the quick dates (No due date, Today, Tomorrow, In a
 * week) and iOS's own calendar inline below them (`@react-native-community/datetimepicker`,
 * `display="inline"`). A quick date or a tapped day sets it and closes the sheet — nothing
 * opens a second sheet while this one is closing (iOS refuses that).
 *
 * The sheet keeps the `choice-sheet` test id of the other field sheets: it is one of them.
 */
import DateTimePicker from '@react-native-community/datetimepicker'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme, useThemeVariant } from '../theme'
import { dateOfDay, dayOfDate, dueChoices } from './fields'
import { Sheet } from './ui'

export function DueDateSheet({
  visible,
  value,
  today,
  onChoose,
  onClose
}: {
  visible: boolean
  /** `YYYY-MM-DD`; null = no due date. */
  value: string | null
  today: string
  onChoose: (day: string | null) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const variant = useThemeVariant()
  const styles = makeStyles(theme)
  const choose = (day: string | null) => {
    onClose()
    onChoose(day)
  }
  const quick = dueChoices(today)
  return (
    <Sheet visible={visible} title="Due date" testID="choice-sheet" onClose={onClose}>
      <ScrollView>
        {quick.map((choice) => {
          const selected = choice.date === value
          return (
            <Pressable
              key={choice.key}
              testID={`choice-${choice.key}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[styles.row, selected && styles.rowSelected]}
              onPress={() => choose(choice.date)}
            >
              <Text style={[styles.label, selected && styles.labelSelected]}>{choice.label}</Text>
              {selected ? <Text style={styles.labelSelected}>✓</Text> : null}
            </Pressable>
          )
        })}
        <View style={styles.calendar}>
          <DateTimePicker
            testID="due-date-calendar"
            value={dateOfDay(value ?? today)}
            mode="date"
            display="inline"
            themeVariant={variant}
            accentColor={theme.primary}
            accessibilityLabel="Pick a day"
            onValueChange={(_event, date) => choose(dayOfDate(date))}
          />
        </View>
      </ScrollView>
    </Sheet>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 48,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    rowSelected: { backgroundColor: t.accent },
    label: { flex: 1, fontSize: 16, color: t.foreground },
    labelSelected: { color: t.accentForeground, fontWeight: '600' },
    calendar: { paddingHorizontal: 8, paddingVertical: 12 }
  })
