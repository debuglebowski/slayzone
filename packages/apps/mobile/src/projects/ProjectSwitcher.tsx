import { HubScope } from '@slayzone/transport/client'
import { useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { projectWaitingCounts } from '../board/card-model'
import { rowKey } from '../hub-board'
import { useHubFeeds } from '../hub-connections'
import { type ChromeColors, PROJECT_COLORS, useTheme } from '../theme'
import { useTRPCClient } from '../trpc'
import { BottomSheet, Caption, CountBadge, Pill, ProjectAvatar } from '../ui-kit/Chrome'
import { type ProjectRef, type ProjectRow, projectTasks } from './hub-projects'
import { useHubProjects } from './use-hub-projects'

/**
 * Switch project (tap the board's project name) — desktop's projects rail as a sheet:
 * every project of every signed-in hub, grouped by hub, each with its task count and an
 * amber count of agents waiting for you there. ⋯ opens a project's settings (its
 * computer, its folder on each computer); ＋ New project creates one on a hub (desktop's
 * Create Project: name, colour; the hub refuses when no computer can hold it), then
 * switches to it and opens its settings to pick its folder.
 */
export function ProjectSwitcher({
  visible,
  selected,
  onSelect,
  onOpenSettings,
  onClose
}: {
  visible: boolean
  selected: ProjectRef | null
  onSelect: (ref: ProjectRef) => void
  /** ⋯ of a project / a project just created: its settings screen. */
  onOpenSettings: (row: { hubLabel: string; projectId: string }) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { feeds } = useHubFeeds()
  const groups = useHubProjects()
  const waiting = projectWaitingCounts(feeds)
  const [creating, setCreating] = useState(false)

  const taskCount = (row: ProjectRow): number => {
    const feed = feeds.find((f) => f.hub.id === row.hubId)
    return feed ? projectTasks(feed, row.project.id).filter((t) => !t.task.archived_at).length : 0
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} testID="project-switcher-sheet">
      {creating ? (
        <NewProject
          onCancel={() => setCreating(false)}
          onCreated={(ref, hubLabel) => {
            setCreating(false)
            onClose()
            onSelect(ref)
            onOpenSettings({ hubLabel, projectId: ref.projectId })
          }}
        />
      ) : (
        <ScrollView>
          {groups.map((group) => (
            <View key={group.hub.id} style={styles.group}>
              <Caption>{group.hub.label} · hub</Caption>
              {group.loading ? (
                <ActivityIndicator color={theme.foreground} style={styles.pad} />
              ) : null}
              {group.problem ? <Text style={styles.note}>Can't reach this hub</Text> : null}
              {group.projects.map((row) => {
                const isSelected =
                  selected?.hubId === row.hubId && selected.projectId === row.project.id
                const count = waiting.get(rowKey(row.hubId, row.project.id)) ?? 0
                return (
                  <View key={row.key} style={styles.row}>
                    <Pressable
                      style={styles.rowMain}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected }}
                      testID={`project-row-${row.project.id}`}
                      onPress={() => {
                        onClose()
                        onSelect({ hubId: row.hubId, projectId: row.project.id })
                      }}
                    >
                      <ProjectAvatar name={row.project.name} color={row.project.color} size={30} />
                      <View style={styles.text}>
                        <Text style={styles.title} numberOfLines={1}>
                          {row.project.name}
                        </Text>
                        <Text style={styles.sub}>
                          {taskCount(row)} {taskCount(row) === 1 ? 'task' : 'tasks'}
                        </Text>
                      </View>
                      {count > 0 ? <CountBadge count={count} /> : null}
                      {isSelected ? <Text style={styles.check}>✓</Text> : null}
                    </Pressable>
                    <Pressable
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`${row.project.name} settings`}
                      testID={`project-settings-${row.project.id}`}
                      onPress={() => {
                        onClose()
                        onOpenSettings({ hubLabel: row.hubLabel, projectId: row.project.id })
                      }}
                    >
                      <Text style={styles.more}>⋯</Text>
                    </Pressable>
                  </View>
                )
              })}
              {!group.loading && !group.problem && group.projects.length === 0 ? (
                <Text style={styles.note}>No projects</Text>
              ) : null}
            </View>
          ))}
          <Pressable
            style={styles.newRow}
            accessibilityRole="button"
            testID="new-project"
            onPress={() => setCreating(true)}
          >
            <Text style={styles.newText}>＋ New project</Text>
          </Pressable>
        </ScrollView>
      )}
    </BottomSheet>
  )
}

function NewProject({
  onCancel,
  onCreated
}: {
  onCancel: () => void
  onCreated: (ref: ProjectRef, hubLabel: string) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { feeds } = useHubFeeds()
  const [name, setName] = useState('')
  const [color, setColor] = useState(PROJECT_COLORS[0])
  const [hubId, setHubId] = useState(feeds[0]?.hub.id ?? '')
  const [busy, setBusy] = useState(false)
  const hub = feeds.find((f) => f.hub.id === hubId)?.hub

  const create = (client: ReturnType<typeof useTRPCClient>) => {
    const trimmed = name.trim()
    if (!trimmed || !hub) return
    setBusy(true)
    client.projects.create
      .mutate({ name: trimmed, color })
      .then((project) => onCreated({ hubId: hub.id, projectId: project.id }, hub.label))
      .catch((error: unknown) =>
        Alert.alert(
          "Couldn't create the project",
          error instanceof Error ? error.message : String(error)
        )
      )
      .finally(() => setBusy(false))
  }

  return (
    <View style={styles.form} testID="new-project-form">
      <Text style={styles.formTitle}>New project</Text>
      <TextInput
        testID="new-project-name"
        value={name}
        onChangeText={setName}
        placeholder="Name"
        placeholderTextColor={theme.mutedForeground}
        style={styles.input}
        autoFocus
        returnKeyType="done"
      />
      <View style={styles.colors}>
        {PROJECT_COLORS.map((c) => (
          <Pressable
            key={c}
            onPress={() => setColor(c)}
            accessibilityRole="button"
            accessibilityState={{ selected: c === color }}
            style={[styles.swatch, { backgroundColor: c }, c === color && styles.swatchOn]}
          />
        ))}
      </View>
      {feeds.length > 1 ? (
        <View style={styles.colors}>
          {feeds.map((f) => (
            <Pill
              key={f.hub.id}
              label={f.hub.label}
              active={f.hub.id === hubId}
              onPress={() => setHubId(f.hub.id)}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.formButtons}>
        <Pressable onPress={onCancel} accessibilityRole="button" style={styles.secondary}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
        {hub ? (
          // The project lives on the hub chosen: the create goes to that hub's client.
          <HubScope hubId={hub.id}>
            <CreateButton
              disabled={busy || !name.trim()}
              label={busy ? 'Creating…' : 'Create'}
              onCreate={create}
            />
          </HubScope>
        ) : null}
      </View>
    </View>
  )
}

function CreateButton({
  disabled,
  label,
  onCreate
}: {
  disabled: boolean
  label: string
  onCreate: (client: ReturnType<typeof useTRPCClient>) => void
}) {
  const styles = makeStyles(useTheme())
  const client = useTRPCClient()
  return (
    <Pressable
      onPress={() => onCreate(client)}
      disabled={disabled}
      accessibilityRole="button"
      testID="new-project-create"
      style={[styles.primary, disabled && styles.disabled]}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    group: { marginBottom: 12 },
    pad: { padding: 12 },
    note: { color: t.mutedForeground, fontSize: 13, paddingVertical: 10 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
    text: { flex: 1 },
    title: { fontSize: 15, fontWeight: '500', color: t.foreground },
    sub: { fontSize: 12, color: t.mutedForeground },
    check: { fontSize: 15, color: t.foreground, fontWeight: '700' },
    more: { fontSize: 20, color: t.mutedForeground, paddingHorizontal: 6 },
    newRow: { paddingVertical: 14 },
    newText: { fontSize: 15, fontWeight: '600', color: t.primary },
    form: { gap: 14, paddingBottom: 8 },
    formTitle: { fontSize: 17, fontWeight: '700', color: t.foreground },
    input: {
      fontSize: 16,
      color: t.foreground,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface2
    },
    colors: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    swatch: { width: 30, height: 30, borderRadius: 9 },
    swatchOn: { borderWidth: 2, borderColor: t.foreground },
    formButtons: { flexDirection: 'row', gap: 10 },
    secondary: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: t.surface3
    },
    secondaryText: { fontSize: 15, fontWeight: '600', color: t.foreground },
    primary: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: t.primary
    },
    primaryText: { fontSize: 15, fontWeight: '600', color: t.primaryForeground },
    disabled: { opacity: 0.5 }
  })
