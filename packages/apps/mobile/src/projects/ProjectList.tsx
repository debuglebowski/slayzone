import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import type { HubProblem } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import type { HubProjects, ProjectRef, ProjectRow } from './hub-projects'

interface Section {
  group: HubProjects
  data: ProjectRow[]
}

/** A hub's state, short, under its name in the list. */
function problemText(problem: HubProblem): string {
  switch (problem.kind) {
    case 'connecting':
      return 'Connecting…'
    case 'unreachable':
      return "Can't reach"
    case 'failed':
      return problem.message
  }
}

/**
 * Every hub's projects under their hub, in sign-in order: the list of the projects
 * screen and of the project picker. Tapping a row hands back the row (hub + project).
 */
export function ProjectList({
  groups,
  selected,
  onSelect
}: {
  groups: readonly HubProjects[]
  /** The project marked as the current one; null = none. */
  selected: ProjectRef | null
  onSelect: (row: ProjectRow) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const sections: Section[] = groups.map((group) => ({ group, data: group.projects }))
  return (
    <SectionList
      sections={sections}
      keyExtractor={(row) => row.key}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <View>
          <Text style={styles.section}>{section.group.hub.label}</Text>
          {section.group.problem ? (
            <Text style={styles.note}>{problemText(section.group.problem)}</Text>
          ) : null}
        </View>
      )}
      renderSectionFooter={({ section }) =>
        section.data.length > 0 || section.group.problem ? null : (
          <Text style={styles.note}>{section.group.loading ? 'Loading…' : 'No projects'}</Text>
        )
      }
      renderItem={({ item }) => {
        const active = item.hubId === selected?.hubId && item.project.id === selected.projectId
        return (
          <Pressable
            testID={`project-${item.hubId}-${item.project.id}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[styles.row, active && styles.rowActive]}
            onPress={() => onSelect(item)}
          >
            <View
              style={[styles.dot, { backgroundColor: item.project.color || theme.mutedForeground }]}
            />
            <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
              {item.project.name}
            </Text>
          </Pressable>
        )
      }}
    />
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    section: {
      fontSize: 12,
      fontWeight: '600',
      color: t.mutedForeground,
      textTransform: 'uppercase',
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 4
    },
    note: { color: t.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    rowActive: { backgroundColor: t.accent },
    dot: { width: 10, height: 10, borderRadius: 5 },
    name: { flex: 1, fontSize: 16, color: t.foreground },
    nameActive: { color: t.accentForeground }
  })
