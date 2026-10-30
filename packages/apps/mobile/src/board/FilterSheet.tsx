import { type DueDateRange, PRIORITY_LABELS } from '@slayzone/tasks/board'
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'
import { type BoardFilter, type BoardTag, DEFAULT_BOARD_FILTER } from './board-model'

const DUE: { value: DueDateRange; label: string }[] = [
  { value: 'all', label: 'Any' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'later', label: 'Later' }
]

/**
 * The board's filters, desktop's (its filter bar and display options): priority, due
 * date, tags (a task with any of them), show completed, show blocked (in a column of its
 * own). Every change applies at once.
 */
export function FilterSheet({
  visible,
  filter,
  tags,
  onChange,
  onClose
}: {
  visible: boolean
  filter: BoardFilter
  tags: readonly BoardTag[]
  onChange: (filter: BoardFilter) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const chip = (label: string, active: boolean, onPress: () => void, testID: string) => (
    <Pressable
      key={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      testID={testID}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  )

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet} testID="filter-sheet">
        <View style={styles.header}>
          <Pressable
            onPress={() => onChange(DEFAULT_BOARD_FILTER)}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={styles.link}>Reset</Text>
          </Pressable>
          <Text style={styles.title}>Filter</Text>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.label}>Priority</Text>
          <View style={styles.chips}>
            {chip(
              'Any',
              filter.priority === null,
              () => onChange({ ...filter, priority: null }),
              'priority-any'
            )}
            {[1, 2, 3, 4, 5].map((p) =>
              chip(
                PRIORITY_LABELS[p],
                filter.priority === p,
                () => onChange({ ...filter, priority: filter.priority === p ? null : p }),
                `priority-${p}`
              )
            )}
          </View>

          <Text style={styles.label}>Due</Text>
          <View style={styles.chips}>
            {DUE.map(({ value, label }) =>
              chip(
                label,
                filter.dueDateRange === value,
                () => onChange({ ...filter, dueDateRange: value }),
                `due-${value}`
              )
            )}
          </View>

          {tags.length > 0 ? (
            <>
              <Text style={styles.label}>Tags</Text>
              <View style={styles.chips}>
                {tags.map((tag) => {
                  const on = filter.tagIds.includes(tag.id)
                  return chip(
                    tag.name,
                    on,
                    () =>
                      onChange({
                        ...filter,
                        tagIds: on
                          ? filter.tagIds.filter((id) => id !== tag.id)
                          : [...filter.tagIds, tag.id]
                      }),
                    `tag-${tag.id}`
                  )
                })}
              </View>
            </>
          ) : null}

          <View style={styles.toggle}>
            <Text style={styles.toggleText}>Show completed</Text>
            <Switch
              testID="show-done"
              value={filter.showDone}
              onValueChange={(showDone) => onChange({ ...filter, showDone })}
            />
          </View>
          <View style={styles.toggle}>
            <Text style={styles.toggleText}>Show blocked column</Text>
            <Switch
              testID="show-blocked"
              value={filter.showBlocked}
              onValueChange={(showBlocked) => onChange({ ...filter, showBlocked })}
            />
          </View>
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
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: { fontSize: 17, fontWeight: '600', color: t.foreground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    body: { padding: 16, gap: 8 },
    label: { fontSize: 13, fontWeight: '600', color: t.mutedForeground, marginTop: 12 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface1
    },
    chipActive: { backgroundColor: t.primary, borderColor: t.primary },
    chipText: { fontSize: 13, color: t.foreground },
    chipTextActive: { color: t.primaryForeground },
    toggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 16
    },
    toggleText: { fontSize: 15, color: t.foreground }
  })
