import { type DueDateRange, PRIORITY_LABELS } from '@slayzone/tasks/board'
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'
import {
  BOARD_GROUPS,
  type BoardFilter,
  type BoardTag,
  clearNarrowing,
  displayGroup,
  GROUP_LABELS,
  LIST_GROUPS,
  resetDisplay,
  SORT_LABELS,
  SORTS
} from './board-model'
import type { BoardView } from './board-prefs'

const DUE: { value: DueDateRange; label: string }[] = [
  { value: 'all', label: 'Any' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'later', label: 'Later' }
]

/**
 * The board's filters, desktop's two toolbar menus. `filter` (its filter bar): priority,
 * due date, tags (a task with any of them). `display` (its Display menu): the view
 * (`views`), grouping (the list's options in the list), ordering, show completed / archived
 * / sub-tasks (not in the tree: it nests them), show empty columns, show blocked (in a
 * column of its own). Every change applies at once.
 */
export function FilterSheet({
  kind,
  visible,
  filter,
  tags,
  views = [],
  view,
  onView,
  onChange,
  onClose
}: {
  kind: 'filter' | 'display'
  visible: boolean
  filter: BoardFilter
  tags: readonly BoardTag[]
  /** Display: the views offered, with their labels. */
  views?: readonly { id: BoardView; label: string }[]
  view?: BoardView
  onView?: (view: BoardView) => void
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

  type Flag = 'showDone' | 'showArchived' | 'showSubTasks' | 'showEmpty' | 'showBlocked'
  const toggle = (label: string, testID: string, key: Flag) => (
    <View style={styles.toggle}>
      <Text style={styles.toggleText}>{label}</Text>
      <Switch
        testID={testID}
        value={filter[key]}
        onValueChange={(on) => onChange({ ...filter, [key]: on })}
      />
    </View>
  )

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet} testID={`${kind}-sheet`}>
        <View style={styles.header}>
          <Pressable
            onPress={() =>
              onChange(kind === 'filter' ? clearNarrowing(filter) : resetDisplay(filter))
            }
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={styles.link}>Reset</Text>
          </Pressable>
          <Text style={styles.title}>{kind === 'filter' ? 'Filter' : 'Display'}</Text>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {kind === 'display' ? (
            <>
              {views.length > 1 ? (
                <>
                  <Text style={styles.label}>View</Text>
                  <View style={styles.chips}>
                    {views.map((v) =>
                      chip(v.label, v.id === view, () => onView?.(v.id), `display-view-${v.id}`)
                    )}
                  </View>
                </>
              ) : null}
              <Text style={styles.label}>Group by</Text>
              <View style={styles.chips}>
                {(view === 'list' ? LIST_GROUPS : BOARD_GROUPS).map((g) =>
                  chip(
                    GROUP_LABELS[g],
                    g === displayGroup(view ?? 'kanban', filter.groupBy),
                    () => onChange({ ...filter, groupBy: g }),
                    `display-group-${g}`
                  )
                )}
              </View>
              <Text style={styles.label}>Sort</Text>
              <View style={styles.chips}>
                {SORTS.map((o) =>
                  chip(
                    SORT_LABELS[o],
                    o === filter.sortBy,
                    () => onChange({ ...filter, sortBy: o }),
                    `display-sort-${o}`
                  )
                )}
              </View>
              {toggle('Show completed', 'show-done', 'showDone')}
              {toggle('Show archived', 'show-archived', 'showArchived')}
              {view === 'tree' ? null : toggle('Show sub-tasks', 'show-subtasks', 'showSubTasks')}
              {toggle(
                view === 'list' ? 'Show empty groups' : 'Show empty columns',
                'show-empty',
                'showEmpty'
              )}
              {toggle('Show blocked column', 'show-blocked', 'showBlocked')}
            </>
          ) : (
            <>
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
            </>
          )}
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
      marginTop: 10
    },
    toggleText: { fontSize: 15, color: t.foreground }
  })
