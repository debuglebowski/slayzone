/**
 * A task, editable — desktop's task detail on the phone: title and fields
 * (`TaskFields`), `children` (the screen's own links and cards), the description
 * (`DescriptionSection`), subtasks, tags, blockers, archive and delete. Reads the task's
 * hub's board (`useHubFeeds`), and scopes itself to that hub, so every write goes to the
 * hub that owns the task whatever screen shows it (the iPad split has no hub scope).
 */
import { HubScope } from '@slayzone/transport/client'
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { TaskRow } from '../hub-board'
import { useHubFeeds } from '../hub-connections'
import { type ChromeColors, useTheme } from '../theme'
import { DescriptionSection } from './DescriptionSection'
import { BlockersSection, SubtasksSection, TagsSection } from './OrganiseSections'
import { TaskActions } from './TaskActions'
import { TaskFields } from './TaskFields'
import { useTaskWrites } from './use-task-writes'

export interface TaskEditorProps {
  row: TaskRow
  showHub: boolean
  /** The task was deleted. */
  onDeleted?: () => void
  /** Shown below the fields. */
  children?: ReactNode
}

export function TaskEditor(props: TaskEditorProps) {
  return (
    <HubScope hubId={props.row.hubId}>
      <Editor {...props} />
    </HubScope>
  )
}

function Editor({ row, showHub, onDeleted, children }: TaskEditorProps) {
  const styles = makeStyles(useTheme())
  const { feeds } = useHubFeeds()
  const board = feeds.find((f) => f.hub.id === row.hubId)?.board.data
  const writes = useTaskWrites(row.task)
  return (
    <View style={styles.editor}>
      <TaskFields row={row} writes={writes} showHub={showHub} />
      {writes.error ? <Text style={styles.error}>{writes.error}</Text> : null}
      {children}
      <DescriptionSection row={row} />
      {board ? (
        <>
          <SubtasksSection row={row} board={board} writes={writes} />
          <TagsSection row={row} board={board} writes={writes} />
          <BlockersSection row={row} board={board} writes={writes} />
        </>
      ) : null}
      <TaskActions writes={writes} onDeleted={onDeleted} />
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    editor: { gap: 20 },
    error: { fontSize: 13, color: t.destructive }
  })
