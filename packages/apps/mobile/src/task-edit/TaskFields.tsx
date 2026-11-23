/**
 * Changing a task's fields — status (the project's columns), priority, due date (quick
 * dates or iOS's calendar, one sheet: `DueDateSheet`) — from wherever the task page shows them (its header's status
 * icon and priority/due, the Details list): `useFieldSheets` hands back `open(field)`
 * and the sheets to render once. And the title, edited in place (`TitleInput`: saved
 * when editing ends; an empty title is not).
 */
import { todayISO } from '@slayzone/tasks/board'
import { type ReactNode, useState } from 'react'
import { Alert, StyleSheet, TextInput } from 'react-native'
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
  const [edit, setEdit] = useState({ id: task.id, base: task.title, text: task.title })
  const resetTitle = () => setEdit({ id: task.id, base: task.title, text: task.title })
  if (edit.id !== task.id || (edit.text === edit.base && edit.base !== task.title)) resetTitle()

  const saveTitle = () => {
    const next = edit.text.trim()
    if (!next || edit.text === edit.base || next === task.title) {
      resetTitle()
      return
    }
    const save = () => {
      void update({ title: next }, { title: next }).then((saved) => {
        if (!saved) return
        setEdit((current) =>
          current.id === task.id && current.base === edit.base
            ? { ...current, base: next, text: current.text === edit.text ? next : current.text }
            : current
        )
      })
    }
    if (task.title === edit.base) {
      save()
      return
    }
    Alert.alert('Replace the hub’s title?', 'The title changed while you were editing it.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Use hub title', onPress: resetTitle },
      { text: 'Overwrite', style: 'destructive', onPress: save }
    ])
  }
  return (
    <TextInput
      value={edit.text}
      onChangeText={(text) => setEdit((current) => ({ ...current, text }))}
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
