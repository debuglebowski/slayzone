import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { HubFeed, TaskRow } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import { mergeHubProjects, type ProjectRef, type ProjectRow, projectTasks } from './hub-projects'
import { ProjectDetail } from './ProjectDetail'
import { ProjectList } from './ProjectList'

/**
 * Every signed-in hub's projects, grouped by hub. `list` (phone): the list alone, a
 * tapped project opens on its own screen. `split` (iPad): the selected project (else the
 * first) beside the list.
 */
export function ProjectsScreen({
  feeds,
  layout,
  selected,
  onSelect,
  onOpenTask,
  onBack
}: {
  feeds: readonly HubFeed[]
  layout: 'list' | 'split'
  selected: ProjectRef | null
  onSelect: (row: ProjectRow) => void
  onOpenTask: (task: TaskRow) => void
  onBack: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const groups = useMemo(() => mergeHubProjects(feeds), [feeds])
  const rows = groups.flatMap((g) => g.projects)
  const shown =
    layout === 'split'
      ? (rows.find((r) => r.hubId === selected?.hubId && r.project.id === selected.projectId) ??
        rows[0] ??
        null)
      : null
  const shownFeed = shown ? feeds.find((f) => f.hub.id === shown.hubId) : undefined

  const list = (
    <ProjectList
      groups={groups}
      selected={shown ? { hubId: shown.hubId, projectId: shown.project.id } : null}
      onSelect={onSelect}
    />
  )

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>‹ Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Projects</Text>
      </View>
      {layout === 'split' ? (
        <View style={styles.split}>
          <View style={styles.listPane}>{list}</View>
          <View style={styles.detailPane}>
            {shown && shownFeed ? (
              <ProjectDetail
                key={shown.key}
                row={shown}
                tasks={projectTasks(shownFeed, shown.project.id)}
                showHub={feeds.length > 1}
                onOpenTask={onOpenTask}
              />
            ) : (
              <Text style={styles.note}>No projects</Text>
            )}
          </View>
        </View>
      ) : (
        list
      )}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    headerTitle: { flex: 1, fontSize: 22, fontWeight: '700', color: t.foreground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    split: { flex: 1, flexDirection: 'row' },
    listPane: {
      width: 340,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: t.border,
      backgroundColor: t.surface1
    },
    detailPane: { flex: 1, backgroundColor: t.card },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' }
  })
