import { computerName } from '@slayzone/computers/labels'
import { HubScope } from '@slayzone/transport/client'
import { useMutation } from '@tanstack/react-query'
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
import { type Choice, ChoiceSheet } from '../computers/ChoiceSheet'
import { ComputerStatus } from '../computers/ComputerStatus'
import { choiceLabel, type HubComputer } from '../computers/hub-computers'
import { useHubComputers } from '../computers/use-hub-computers'
import type { TaskRow } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPC } from '../trpc'
import { type FolderRow, placementStatusText, projectFolders } from './folders'
import { FolderPicker } from './FolderPicker'
import type { ProjectRow } from './hub-projects'

/** The choice key of "no default computer" (null: the hub picks, desktop calls it Local). */
const LOCAL = '__local__'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * A project: the computer it runs on by default, its folder on every computer of its hub,
 * and its tasks. Edits are desktop's, through the same hub procedures and checks:
 *
 * - a folder per computer: picked on THAT computer (`FolderPicker`), set with
 *   `workspace.setProjectPath` (the computer confirms it exists and lies within its
 *   allowed roots; an unreachable one gets it when it next connects), removed with
 *   `workspace.forgetProjectPath` (the folder on disk is left alone);
 * - the default computer: `computers.setProjectDefaultComputer` (Local = none).
 *
 * The hub then says its tasks changed and the board, with the project's folders, loads
 * again. Scopes itself to the hub that owns the project: every write goes there.
 */
export function ProjectDetail({
  row,
  tasks,
  showHub,
  onOpenTask
}: {
  row: ProjectRow
  /** The project's top-level tasks (`projectTasks`). */
  tasks: readonly TaskRow[]
  showHub: boolean
  onOpenTask: (task: TaskRow) => void
}) {
  return (
    <HubScope hubId={row.hubId}>
      <ProjectDetailBody row={row} tasks={tasks} showHub={showHub} onOpenTask={onOpenTask} />
    </HubScope>
  )
}

function ProjectDetailBody({
  row,
  tasks,
  showHub,
  onOpenTask
}: {
  row: ProjectRow
  tasks: readonly TaskRow[]
  showHub: boolean
  onOpenTask: (task: TaskRow) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { project } = row
  const { computers, pending, error } = useHubComputers()
  const folders = projectFolders(project, computers)

  return (
    <ScrollView contentContainerStyle={styles.detail} testID={`project-detail-${project.id}`}>
      <View style={styles.titleRow}>
        <View style={[styles.dot, { backgroundColor: project.color || theme.mutedForeground }]} />
        <Text style={styles.title}>{project.name}</Text>
      </View>
      {showHub ? <Text style={styles.chip}>{row.hubLabel}</Text> : null}

      {pending ? (
        <ActivityIndicator color={theme.mutedForeground} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <DefaultComputer row={row} computers={computers} />
      )}

      <Text style={styles.section}>Folders</Text>
      {folders.kind === 'legacy' ? (
        <View style={styles.card}>
          <Text style={styles.path}>{folders.path ?? 'No folder'}</Text>
          <Text style={styles.note}>
            This hub is older: it keeps one folder for every computer. Update it to set a folder per
            computer.
          </Text>
        </View>
      ) : pending || error ? null : folders.rows.length === 0 ? (
        <Text style={styles.note}>No computers on this hub.</Text>
      ) : (
        folders.rows.map((folder) => (
          <FolderItem key={folder.computerId} row={row} folder={folder} />
        ))
      )}

      <Text style={styles.section}>Tasks</Text>
      {tasks.length === 0 ? <Text style={styles.note}>No tasks</Text> : null}
      {tasks.map((task) => (
        <Pressable
          key={task.key}
          accessibilityRole="button"
          style={styles.task}
          onPress={() => onOpenTask(task)}
        >
          <Text style={styles.taskTitle} numberOfLines={2}>
            {task.task.title}
          </Text>
          <Text style={styles.taskMeta}>{task.task.status}</Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}

/** The computer the project's tasks run on unless a task names its own. */
function DefaultComputer({ row, computers }: { row: ProjectRow; computers: HubComputer[] }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const { mutateAsync: setDefault } = useMutation(
    trpc.computers.setProjectDefaultComputer.mutationOptions()
  )
  const saved = row.project.default_computer_id ?? null
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Shown at once; re-synced (during render) when the saved default or project changes.
  const [chosen, setChosen] = useState<string | null>(saved)
  const [syncedFrom, setSyncedFrom] = useState({ projectId: row.project.id, saved })
  if (syncedFrom.projectId !== row.project.id || syncedFrom.saved !== saved) {
    setSyncedFrom({ projectId: row.project.id, saved })
    setChosen(saved)
  }

  const choices: Choice[] = [
    { key: LOCAL, label: computerName(computers, null) },
    ...computers.map((c) => ({ key: c.id, label: choiceLabel(c) }))
  ]
  const choose = (key: string): void => {
    const computerId = key === LOCAL ? null : key
    if (computerId === chosen) return
    setChosen(computerId)
    setError(null)
    setDefault({ projectId: row.project.id, computerId }).catch((err: unknown) => {
      setChosen(saved)
      setError(`Couldn't change the default computer: ${messageOf(err)}`)
    })
  }

  return (
    <View style={styles.block}>
      <Text style={styles.section}>Default computer</Text>
      <Pressable
        testID="project-default-computer"
        accessibilityRole="button"
        style={styles.choice}
        onPress={() => setOpen(true)}
      >
        <Text style={styles.choiceLabel} numberOfLines={1}>
          {choices.find((c) => c.key === (chosen ?? LOCAL))?.label ??
            computerName(computers, chosen)}
        </Text>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
      <Text style={styles.note}>
        Where tasks in this project run by default. Tasks can override this individually.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ChoiceSheet
        visible={open}
        title="Default computer"
        choices={choices}
        selectedKey={chosen ?? LOCAL}
        onChoose={choose}
        onClose={() => setOpen(false)}
      />
    </View>
  )
}

/** One computer's folder of the project: where it is, its state, change / remove. */
function FolderItem({ row, folder }: { row: ProjectRow; folder: FolderRow }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const setPath = useMutation(trpc.workspace.setProjectPath.mutationOptions())
  const forget = useMutation(trpc.workspace.forgetProjectPath.mutationOptions())
  const [picking, setPicking] = useState(false)
  const target = { computerId: folder.computerId, projectId: row.project.id }
  const busy = setPath.isPending || forget.isPending
  const status = folder.placement ? placementStatusText(folder.placement.status) : null
  // A computer the hub no longer lists is not the user's to change.
  const editable = folder.computer !== null

  const choose = (path: string): void => {
    setPath
      .mutateAsync({ ...target, path })
      .catch((err: unknown) => Alert.alert("Couldn't use that folder", messageOf(err)))
  }
  const remove = (): void => {
    forget
      .mutateAsync(target)
      .catch((err: unknown) => Alert.alert("Couldn't remove that folder", messageOf(err)))
  }

  return (
    <View style={styles.card} testID={`folder-${folder.computerId}`}>
      <View style={styles.folderHead}>
        <Text style={styles.computer} numberOfLines={1}>
          {folder.name}
        </Text>
        {folder.isDefault ? <Text style={styles.tag}>Default</Text> : null}
        {folder.computer ? <ComputerStatus computer={folder.computer} /> : null}
      </View>
      <Text style={folder.placement ? styles.path : styles.note} selectable>
        {folder.placement?.path ?? 'No folder'}
      </Text>
      {status ? (
        <Text style={folder.placement?.status === 'pending' ? styles.note : styles.error}>
          {status}
        </Text>
      ) : null}
      {editable ? (
        <View style={styles.actions}>
          {busy ? <ActivityIndicator color={theme.mutedForeground} /> : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            hitSlop={8}
            onPress={() => setPicking(true)}
          >
            <Text style={styles.link}>{folder.placement ? 'Change' : 'Pick folder'}</Text>
          </Pressable>
          {folder.placement ? (
            <Pressable accessibilityRole="button" disabled={busy} hitSlop={8} onPress={remove}>
              <Text style={styles.link}>Remove</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <FolderPicker
        visible={picking}
        target={target}
        defaultPath={folder.placement?.path ?? null}
        title={`Folder on ${folder.name}`}
        onSelect={choose}
        onClose={() => setPicking(false)}
      />
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    detail: { padding: 20, gap: 10 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    dot: { width: 12, height: 12, borderRadius: 6 },
    title: { flex: 1, fontSize: 22, fontWeight: '600', color: t.foreground },
    chip: {
      alignSelf: 'flex-start',
      fontSize: 12,
      color: t.foreground,
      backgroundColor: t.muted,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      overflow: 'hidden'
    },
    block: { gap: 6 },
    section: {
      fontSize: 12,
      fontWeight: '600',
      color: t.mutedForeground,
      textTransform: 'uppercase',
      marginTop: 12
    },
    choice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.card
    },
    choiceLabel: { flex: 1, fontSize: 15, color: t.foreground },
    chevron: { fontSize: 18, color: t.mutedForeground },
    card: {
      gap: 4,
      padding: 12,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.card
    },
    folderHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    computer: { fontSize: 15, fontWeight: '600', color: t.foreground, flexShrink: 1 },
    tag: {
      fontSize: 11,
      color: t.accentForeground,
      backgroundColor: t.accent,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      overflow: 'hidden'
    },
    path: { fontFamily: 'Menlo', fontSize: 13, color: t.foreground },
    actions: { flexDirection: 'row', alignItems: 'center', gap: 20, marginTop: 6 },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    note: { fontSize: 13, color: t.mutedForeground },
    error: { fontSize: 13, color: t.destructive },
    task: {
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    taskTitle: { fontSize: 15, color: t.foreground },
    taskMeta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 }
  })
