import { useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { agentDotOf } from '../board/card-model'
import type { AgentRow } from '../agents/hub-agents'
import type { HubFeed } from '../hub-board'
import { useHubFeeds } from '../hub-connections'
import type { ProjectRef } from '../projects/hub-projects'
import { type ChromeColors, useTheme } from '../theme'
import { BottomSheet, Pill } from '../ui-kit/Chrome'
import { AgentDot } from '../ui-kit/TaskGlyphs'
import { attentionLoad, attentionRows, attentionSections, attentionSubtitle } from './attention'

/**
 * The 🔔 sheet — desktop's bell + agent status panel: every hub's agents under a header
 * per group, the ones ready for review first, for all projects or the board's project.
 * Until the hubs' agents are in it says so (and why, when they could not be read),
 * rather than "No agents". Tap one: into its task. × on an unread one: dismissed (the
 * task is marked read on its hub, as opening it would; desktop's "mark as read").
 */
export function AttentionSheet({
  feeds,
  visible,
  project,
  onOpen,
  onClose
}: {
  /** Every signed-in hub's feed (`useHubFeeds`). */
  feeds: readonly HubFeed[]
  visible: boolean
  /** The board's project (the "this project" choice); null = none shown. */
  project: (ProjectRef & { name: string }) | null
  onOpen: (row: AgentRow) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { clientFor } = useHubFeeds()
  const [onlyProject, setOnlyProject] = useState(false)
  const rows = attentionRows(feeds, onlyProject && project ? project : null)
  const load = attentionLoad(feeds)
  const severalHubs = feeds.length > 1

  const dismiss = (row: AgentRow) => {
    clientFor(row.hubId)
      .task.update.mutate({ id: row.task.id, needsAttention: false })
      .catch((error: unknown) =>
        Alert.alert("Couldn't dismiss", error instanceof Error ? error.message : String(error))
      )
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} testID="attention-sheet">
      <View style={styles.scopes}>
        <Pill
          label="All projects"
          active={!onlyProject || !project}
          onPress={() => setOnlyProject(false)}
          testID="attention-all"
        />
        {project ? (
          <Pill
            label={project.name}
            active={onlyProject}
            onPress={() => setOnlyProject(true)}
            testID="attention-project"
          />
        ) : null}
      </View>
      <ScrollView>
        {load.kind === 'error' ? (
          <Text style={styles.problem}>Couldn’t load the agents. {load.message}</Text>
        ) : null}
        {rows.length === 0 && load.kind === 'loading' ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.mutedForeground} />
            <Text style={styles.note}>Loading agents…</Text>
          </View>
        ) : null}
        {rows.length === 0 && load.kind === 'ready' ? (
          <Text style={styles.note}>No agents</Text>
        ) : null}
        {attentionSections(rows).map((section) => (
          <View key={section.group}>
            <Text style={styles.header} accessibilityRole="header">
              {section.title}
            </Text>
            {section.rows.map((row) => {
              const dot = agentDotOf(row.state, row.unread)
              return (
                <View key={row.key} style={styles.row}>
                  <Pressable
                    style={styles.rowMain}
                    accessibilityRole="button"
                    testID={`attention-row-${row.task.id}`}
                    onPress={() => {
                      onClose()
                      onOpen(row)
                    }}
                  >
                    <View style={styles.dot}>{dot ? <AgentDot kind={dot} /> : null}</View>
                    <View style={styles.text}>
                      <Text style={styles.title} numberOfLines={1}>
                        {row.task.title}
                      </Text>
                      <Text style={styles.sub} numberOfLines={1}>
                        {attentionSubtitle(row, severalHubs)}
                      </Text>
                    </View>
                  </Pressable>
                  {row.unread ? (
                    <Pressable
                      onPress={() => dismiss(row)}
                      style={styles.dismissButton}
                      accessibilityRole="button"
                      accessibilityLabel={`Dismiss ${row.task.title}`}
                      testID={`attention-dismiss-${row.task.id}`}
                    >
                      <Text style={styles.dismiss} maxFontSizeMultiplier={1.4}>
                        ✕
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              )
            })}
          </View>
        ))}
      </ScrollView>
    </BottomSheet>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    scopes: { flexDirection: 'row', gap: 6, marginBottom: 6 },
    note: { color: t.mutedForeground, paddingVertical: 24, textAlign: 'center' },
    loading: { alignItems: 'center', paddingTop: 24 },
    problem: { color: t.destructive, fontSize: 13, paddingVertical: 10 },
    header: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.6,
      color: t.mutedForeground,
      textTransform: 'uppercase',
      paddingTop: 14,
      paddingBottom: 6
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
    dot: { width: 12, alignItems: 'center' },
    text: { flex: 1 },
    title: { fontSize: 15, color: t.foreground },
    sub: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    dismissButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    dismiss: { fontSize: 14, color: t.mutedForeground }
  })
