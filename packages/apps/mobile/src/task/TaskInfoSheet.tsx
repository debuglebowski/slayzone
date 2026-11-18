/**
 * The phone's Details / Artifacts sheet — the task page's ⓘ (its own route,
 * `task/<hub>/<id>/info`, presented as iOS's sheet over the page: medium, then large).
 *
 * At the top, the task: the status icon (tap: change status), the title (edit in
 * place), ⋯ (keep a temporary task, mark unread, archive, delete), Done; priority, tags
 * and due date under it. Then Details | Artifacts (with how many): Details is desktop's
 * Settings panel (description, sub-tasks, the details list), Artifacts the task's list.
 * A part, once shown, stays mounted while the other is shown (an edit in progress, an
 * upload survive); each mounts the first time it is shown.
 *
 * Scopes itself to the task's hub: every read and write goes to the hub that owns it.
 */
import { HubScope } from '@slayzone/transport/client'
import { type ReactNode, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ArtifactsScreen } from '../artifacts/ArtifactsScreen'
import { useTaskArtifacts } from '../artifacts/use-task-artifacts'
import type { HubFeed, TaskRow } from '../hub-board'
import type { HubSession } from '../hub-session'
import { useFieldSheets } from '../task-edit/TaskFields'
import { useTaskWrites } from '../task-edit/use-task-writes'
import { type ChromeColors, useTheme } from '../theme'
import {
  artifactsLabel,
  DetailsPanel,
  KeptPart,
  PartSegments,
  TaskMenu,
  TaskMenuButton,
  TitleBlock
} from './task-parts'
import { INFO_SEGMENTS, type InfoSegment } from './TaskPage'

export type { InfoSegment } from './TaskPage'

export interface TaskInfoSheetProps {
  row: TaskRow
  /** The feed of the hub that owns the task. */
  feed: HubFeed
  session: HubSession
  showHub: boolean
  segment: InfoSegment
  onSegment: (segment: InfoSegment) => void
  /** Done: the sheet goes. */
  onClose: () => void
  onDeleted: () => void
  /** A sub-task was tapped. */
  onOpenTask: (taskId: string) => void
  /** An artifact of the list was tapped. */
  onOpenArtifact: (artifactId: string, version: number | null) => void
}

export function TaskInfoSheet(props: TaskInfoSheetProps) {
  return (
    <HubScope hubId={props.row.hubId}>
      <Sheet {...props} />
    </HubScope>
  )
}

function Sheet(props: TaskInfoSheetProps) {
  const { row, segment, onSegment } = props
  const styles = makeStyles(useTheme())
  const writes = useTaskWrites(row.task)
  const fields = useFieldSheets(row, writes)
  const [menu, setMenu] = useState(false)
  const { artifacts } = useTaskArtifacts(row.task.id)
  // The parts shown so far: each stays mounted from its first showing on.
  const [visited, setVisited] = useState<ReadonlySet<InfoSegment>>(() => new Set([segment]))
  if (!visited.has(segment)) setVisited(new Set([...visited, segment]))

  const kept = (part: InfoSegment, node: ReactNode) =>
    visited.has(part) ? (
      <KeptPart key={part} shown={segment === part} testID={`part-${part}`}>
        {node}
      </KeptPart>
    ) : null

  return (
    <View style={styles.sheet} testID="task-info-sheet">
      <TitleBlock
        row={row}
        writes={writes}
        feed={props.feed}
        showHub={props.showHub}
        openField={fields.open}
        trailing={
          <View style={styles.trailing}>
            <TaskMenuButton onPress={() => setMenu(true)} />
            <Pressable
              onPress={props.onClose}
              accessibilityRole="button"
              accessibilityLabel="Done"
              style={({ pressed }) => [styles.done, pressed && styles.pressed]}
            >
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </View>
        }
      />
      {writes.error ? <Text style={styles.error}>{writes.error}</Text> : null}
      <PartSegments
        parts={INFO_SEGMENTS}
        shown={segment}
        labelOf={(part) => (part === 'details' ? 'Details' : artifactsLabel(artifacts?.length))}
        onShow={onSegment}
      />
      <View style={styles.flex}>
        {kept(
          'details',
          <DetailsPanel
            row={row}
            feed={props.feed}
            writes={writes}
            openField={fields.open}
            onOpenTask={props.onOpenTask}
          />
        )}
        {kept(
          'artifacts',
          <ArtifactsScreen
            session={props.session}
            taskId={row.task.id}
            layout="list"
            selected={null}
            embedded
            onSelect={(id) => props.onOpenArtifact(id, null)}
            onSelectVersion={props.onOpenArtifact}
            onBack={() => onSegment('details')}
          />
        )}
      </View>
      {fields.sheets}
      <TaskMenu
        visible={menu}
        writes={writes}
        columns={row.project?.columns_config}
        onDeleted={props.onDeleted}
        onClose={() => setMenu(false)}
      />
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    sheet: { flex: 1, backgroundColor: t.background, paddingTop: 18 },
    flex: { flex: 1 },
    pressed: { opacity: 0.6 },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    done: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 6 },
    doneText: { fontSize: 16, fontWeight: '600', color: t.primary },
    error: { color: t.destructive, fontSize: 13, paddingHorizontal: 16, paddingBottom: 4 }
  })
