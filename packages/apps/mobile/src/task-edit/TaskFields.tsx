/**
 * Changing a task's fields — status (the project's columns), priority, due date (quick
 * dates or a typed day) — from wherever the task page shows them (its header's status
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
import { dueChoices, parseDueDate, PRIORITY_CHOICES, statusChoices } from './fields'
import { PromptSheet } from './ui'
import type { TaskWrites } from './use-task-writes'

const PICK_DATE = 'pick'

export type TaskField = 'status' | 'priority' | 'due'
type Open = TaskField | 'date' | null

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

  const dues = dueChoices(today)
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
      <ChoiceSheet
        visible={open === 'due'}
        title="Due date"
        choices={[...dues, { key: PICK_DATE, label: 'Pick a date…' }]}
        selectedKey={dues.find((d) => d.date === (task.due_date ?? null))?.key ?? null}
        onChoose={(key) => {
          if (key === PICK_DATE) setOpen('date')
          else setDue(dues.find((d) => d.key === key)?.date ?? null)
        }}
        onClose={() => setOpen((o) => (o === 'due' ? null : o))}
      />
      {open === 'date' ? (
        <PromptSheet
          visible
          title="Due date"
          placeholder="YYYY-MM-DD"
          submitLabel="Set"
          inputTestID="due-date-input"
          initial={task.due_date ?? ''}
          validate={(text) => (parseDueDate(text) ? null : 'Type a date as YYYY-MM-DD')}
          onSubmit={(text) => setDue(parseDueDate(text))}
          onClose={() => setOpen(null)}
        />
      ) : null}
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
