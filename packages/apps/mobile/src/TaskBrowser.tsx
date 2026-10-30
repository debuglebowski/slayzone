import { useMemo } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentRow } from './agents/hub-agents'
import { HubBanners } from './HubBanner'
import { type HubFeed, hubProblem, mergeHubTasks, type TaskRow } from './hub-board'
import { TaskDetail } from './TaskDetail'
import { type ChromeColors, useTheme } from './theme'

/** Wide enough for list + detail side by side (iPad, any orientation). */
export const SPLIT_MIN_WIDTH = 700

export interface TaskBrowserProps {
  /** Every signed-in hub's feed, in sign-in order (`useHubFeeds`). */
  feeds: readonly HubFeed[]
  /** `split`: list + the selected task beside it (iPad); `list`: the list alone (phone). */
  layout: 'list' | 'split'
  /** The task shown beside the list; null = the first. */
  selected: { hubId: string; taskId: string } | null
  /** A row was tapped: phone opens it, iPad shows it beside the list. */
  onSelect: (row: TaskRow) => void
  onRetry: (hubId: string) => void
  onSignOut: (hubId: string) => void
  /** "Projects": every hub's projects. */
  onShowProjects: () => void
  /** Beside the list, the shown task's "Agent ›" was tapped: its agent screen. */
  onOpenAgent: (row: Pick<AgentRow, 'hubId' | 'hubLabel' | 'task'>) => void
}

/**
 * The Tasks tab: every signed-in hub's tasks in one read-only list (the board rows of
 * `task.loadBoardData`, the procedure the desktop board loads), each row tagged with
 * its hub when there are several. A hub that can't be reached gets a banner with
 * Retry and Sign out; the other hubs' rows stay. The header opens every hub's projects.
 */
export function TaskBrowser({
  feeds,
  layout,
  selected,
  onSelect,
  onRetry,
  onSignOut,
  onShowProjects,
  onOpenAgent
}: TaskBrowserProps) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const rows = useMemo(() => mergeHubTasks(feeds), [feeds])
  const severalHubs = feeds.length > 1
  const onlyHub = feeds.length === 1 ? feeds[0].hub : null
  const loading = rows.length === 0 && feeds.some((f) => f.board.pending && !hubProblem(f))
  const refreshing = feeds.some((f) => f.board.refreshing)

  const header = (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          Tasks
        </Text>
        <Text style={styles.headerSub} numberOfLines={1}>
          {onlyHub ? onlyHub.label : `${feeds.length} hubs`}
        </Text>
      </View>
      <Pressable onPress={onShowProjects} hitSlop={8} accessibilityRole="button">
        <Text style={styles.link}>Projects</Text>
      </Pressable>
    </View>
  )

  const banners = <HubBanners feeds={feeds} onRetry={onRetry} onSignOut={onSignOut} />

  if (loading) {
    return (
      <View style={styles.screen}>
        {header}
        {banners}
        <View style={styles.center}>
          <ActivityIndicator color={theme.foreground} />
        </View>
      </View>
    )
  }

  const shown =
    layout === 'split'
      ? (rows.find((r) => r.hubId === selected?.hubId && r.task.id === selected?.taskId) ??
        rows[0] ??
        null)
      : null

  const list = (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.key}
      ListEmptyComponent={<Text style={styles.note}>No tasks</Text>}
      refreshing={refreshing}
      onRefresh={() => {
        for (const feed of feeds) onRetry(feed.hub.id)
      }}
      renderItem={({ item }) => {
        const active = shown?.key === item.key
        const meta = [item.project?.name ?? 'Unknown project', item.task.status]
        if (severalHubs) meta.push(item.hubLabel)
        return (
          <Pressable
            style={[styles.row, active && styles.rowActive]}
            onPress={() => onSelect(item)}
          >
            <View
              style={[
                styles.dot,
                { backgroundColor: item.project?.color ?? theme.mutedForeground }
              ]}
            />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, active && styles.rowTitleActive]} numberOfLines={2}>
                {item.task.title}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {meta.join(' · ')}
              </Text>
            </View>
          </Pressable>
        )
      }}
    />
  )

  return (
    <View style={styles.screen}>
      {header}
      {banners}
      {layout === 'split' ? (
        <View style={styles.split}>
          <View style={styles.listPane}>{list}</View>
          <View style={styles.detailPane}>
            {shown ? (
              <TaskDetail
                row={shown}
                showHub={severalHubs}
                onOpenAgent={() => onOpenAgent(shown)}
              />
            ) : (
              <Text style={styles.note}>Select a task</Text>
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
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    headerText: { flex: 1 },
    headerTitle: { fontSize: 22, fontWeight: '700', color: t.foreground },
    headerSub: { fontSize: 12, color: t.mutedForeground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    note: { color: t.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 },
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
    rowMeta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 }
  })
