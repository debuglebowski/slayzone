import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
import { type ChromeColors, useTheme } from './theme'
import { type RouterOutputs, useTRPC } from './trpc'

/** Wide enough for list + detail side by side (iPad, any orientation). */
const SPLIT_MIN_WIDTH = 700

type BoardTask = RouterOutputs['task']['loadBoardData']['tasks'][number]

const PRIORITY = ['', 'Urgent', 'High', 'Medium', 'Low', 'Someday']

/**
 * Read-only task list from the hub's `task.loadBoardData` — the same procedure the
 * desktop board loads. Phone: list, tap for detail. iPad: list + detail side by side.
 */
export function TaskBrowser({ hubLabel, onSignOut }: { hubLabel: string; onSignOut: () => void }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const board = useQuery(trpc.task.loadBoardData.queryOptions(undefined, { staleTime: 30_000 }))
  const { width } = useWindowDimensions()
  const split = width >= SPLIT_MIN_WIDTH
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const tasks = (board.data?.tasks ?? []).filter((t) => t.parent_id === null)
  const projects = new Map(
    (board.data?.projects ?? []).flatMap((p) => (p ? [[p.id, p] as const] : []))
  )
  // iPad shows the first task until one is picked; a phone shows the list.
  const selected = tasks.find((t) => t.id === selectedId) ?? (split ? (tasks[0] ?? null) : null)

  const header = (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={styles.headerTitle}>Tasks</Text>
        <Text style={styles.headerSub} numberOfLines={1}>
          {hubLabel}
        </Text>
      </View>
      <Pressable onPress={onSignOut} hitSlop={8}>
        <Text style={styles.link}>Sign out</Text>
      </Pressable>
    </View>
  )

  // The header (with Sign out) stays while the board loads or fails: a session whose hub
  // is gone must still be able to sign out.
  if (board.isPending) {
    return (
      <View style={styles.screen}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={theme.foreground} />
        </View>
      </View>
    )
  }
  if (board.isError) {
    return (
      <View style={styles.screen}>
        {header}
        <View style={styles.center}>
          <Text style={styles.error}>{board.error.message}</Text>
          <Pressable onPress={() => void board.refetch()}>
            <Text style={styles.link}>Retry</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  const list = (
    <FlatList
      data={tasks}
      keyExtractor={(t) => t.id}
      ListEmptyComponent={<Text style={styles.empty}>No tasks</Text>}
      refreshing={board.isRefetching}
      onRefresh={() => void board.refetch()}
      renderItem={({ item }) => {
        const project = projects.get(item.project_id)
        const active = split && selected?.id === item.id
        return (
          <Pressable
            style={[styles.row, active && styles.rowActive]}
            onPress={() => setSelectedId(item.id)}
          >
            <View
              style={[styles.dot, { backgroundColor: project?.color ?? theme.mutedForeground }]}
            />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, active && styles.rowTitleActive]} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {project?.name ?? 'Unknown project'} · {item.status}
              </Text>
            </View>
          </Pressable>
        )
      }}
    />
  )

  if (split) {
    return (
      <View style={styles.screen}>
        {header}
        <View style={styles.split}>
          <View style={styles.listPane}>{list}</View>
          <View style={styles.detailPane}>
            {selected ? (
              <TaskDetail task={selected} projectName={projects.get(selected.project_id)?.name} />
            ) : (
              <Text style={styles.empty}>Select a task</Text>
            )}
          </View>
        </View>
      </View>
    )
  }

  if (selected) {
    return (
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={() => setSelectedId(null)} hitSlop={8}>
            <Text style={styles.link}>‹ Tasks</Text>
          </Pressable>
        </View>
        <TaskDetail task={selected} projectName={projects.get(selected.project_id)?.name} />
      </View>
    )
  }

  return (
    <View style={styles.screen}>
      {header}
      {list}
    </View>
  )
}

function TaskDetail({ task, projectName }: { task: BoardTask; projectName?: string }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  return (
    <ScrollView contentContainerStyle={styles.detail}>
      <Text style={styles.detailTitle}>{task.title}</Text>
      <View style={styles.chips}>
        <Text style={styles.chip}>{projectName ?? 'Unknown project'}</Text>
        <Text style={styles.chip}>{task.status}</Text>
        <Text style={styles.chip}>{PRIORITY[task.priority] ?? `P${task.priority}`}</Text>
      </View>
      <Text style={styles.detailBody}>{task.description?.trim() || 'No description'}</Text>
    </ScrollView>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      backgroundColor: t.background
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    headerText: { flex: 1 },
    headerTitle: { fontSize: 22, fontWeight: '700', color: t.foreground },
    headerSub: { fontSize: 12, color: t.mutedForeground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    error: { color: t.destructive, paddingHorizontal: 24, textAlign: 'center' },
    empty: { color: t.mutedForeground, padding: 24, textAlign: 'center' },
    split: { flex: 1, flexDirection: 'row' },
    listPane: {
      width: 340,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: t.border,
      backgroundColor: t.surface1
    },
    detailPane: { flex: 1, backgroundColor: t.card },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    rowActive: { backgroundColor: t.accent },
    dot: { width: 10, height: 10, borderRadius: 5 },
    rowText: { flex: 1 },
    rowTitle: { fontSize: 16, color: t.foreground },
    rowTitleActive: { color: t.accentForeground },
    rowMeta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    detail: { padding: 20, gap: 12 },
    detailTitle: { fontSize: 22, fontWeight: '600', color: t.foreground },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      fontSize: 12,
      color: t.foreground,
      backgroundColor: t.muted,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      overflow: 'hidden'
    },
    detailBody: { fontSize: 15, lineHeight: 22, color: t.foreground }
  })
