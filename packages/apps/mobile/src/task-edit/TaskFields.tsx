/**
 * Changing a task's fields — status (the project's columns), priority, due date (quick
 * dates or iOS's calendar, one sheet: `DueDateSheet`) — from wherever the task page shows them (its header's status
 * icon and priority/due, the Details list): `useFieldSheets` hands back `open(field)`
 * and the sheets to render once. And the title, edited in place (`TitleInput`: saved
 * when editing ends; an empty title is not).
 */
import { todayISO } from '@slayzone/tasks/board'
import { type ReactNode, useState } from 'react'
import { StyleSheet, TextInput } from 'react-native'
import type { TaskRow } from '../hub-board'
import { ChoiceSheet } from '../computers/ChoiceSheet'
import { type ChromeColors, useTheme } from '../theme'
import { DueDateSheet } from './DueDateSheet'
import { PRIORITY_CHOICES, statusChoices } from './fields'
import type { TaskWrites } from './use-task-writes'

export type TaskField = 'status' | 'priority' | 'due'
type Open = TaskField | null

export function useFieldSheets(
  row: TaskRow,
  writes: TaskWrites
): { open: (field: TaskField) => void; sheets: ReactNode } {
  const { task, update } = writes
  const [open, setOpen] = useState<Open>(null)
  const today = todayISO()

  const setStatus = (status: string) => {
    if (status !== task.status) void update({ status }, { status })
  }
  const setPriority = (key: string) => {
    const priority = Number(key)
    if (priority !== task.priority) void update({ priority }, { priority })
  }
  const setDue = (dueDate: string | null) => {
    if (dueDate !== (task.due_date ?? null)) void update({ due_date: dueDate }, { dueDate })
  }

  const sheets = (
    <>
      <ChoiceSheet
        visible={open === 'status'}
        title="Status"
        choices={statusChoices(row.project)}
        selectedKey={task.status}
        onChoose={setStatus}
        onClose={() => setOpen(null)}
      />
      <ChoiceSheet
        visible={open === 'priority'}
        title="Priority"
        choices={PRIORITY_CHOICES}
        selectedKey={String(task.priority)}
        onChoose={setPriority}
        onClose={() => setOpen(null)}
      />
      <DueDateSheet
        visible={open === 'due'}
        value={task.due_date ?? null}
        today={today}
        onChoose={setDue}
        onClose={() => setOpen(null)}
      />
    </>
  )
  return { open: setOpen, sheets }
}

export function TitleInput({ writes }: { writes: TaskWrites }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { task, update } = writes
  // The title as typed; follows the task's when that changes (render-time sync).
  const [title, setTitle] = useState(task.title)
  const [titleOf, setTitleOf] = useState({ id: task.id, title: task.title })
  if (titleOf.id !== task.id || titleOf.title !== task.title) {
    setTitleOf({ id: task.id, title: task.title })
    setTitle(task.title)
  }
  const saveTitle = () => {
    const next = title.trim()
    if (!next || next === task.title) {
      setTitle(task.title)
      return
    }
    void update({ title: next }, { title: next })
  }
  return (
    <TextInput
      value={title}
      onChangeText={setTitle}
      onEndEditing={saveTitle}
      style={styles.title}
      multiline
      scrollEnabled={false}
      submitBehavior="blurAndSubmit"
      returnKeyType="done"
      accessibilityLabel="Title"
      placeholder="Title"
      placeholderTextColor={theme.mutedForeground}
    />
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    title: { flex: 1, fontSize: 20, fontWeight: '700', color: t.foreground, padding: 0 }
  })
