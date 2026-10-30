/**
 * A task's title and fields, editable: the title in place (saved when editing ends; an
 * empty title is not), status (the project's columns), priority, due date (quick dates
 * or a typed day). Project and hub show, read-only.
 */
import { todayISO } from '@slayzone/tasks/board'
import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import type { TaskRow } from '../hub-board'
import { ChoiceSheet } from '../computers/ChoiceSheet'
import { type ChromeColors, useTheme } from '../theme'
import {
  dueChoices,
  dueLabel,
  parseDueDate,
  PRIORITY_CHOICES,
  priorityLabel,
  statusChoices,
  statusLabel
} from './fields'
import { FieldButton, PromptSheet } from './ui'
import type { TaskWrites } from './use-task-writes'

const PICK_DATE = 'pick'

type Open = 'status' | 'priority' | 'due' | 'date' | null

export function TaskFields({
  row,
  writes,
  showHub
}: {
  row: TaskRow
  writes: TaskWrites
  showHub: boolean
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { task, update } = writes
  const [open, setOpen] = useState<Open>(null)
  const today = todayISO()

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
  return (
    <View style={styles.fields}>
      <TextInput
        value={title}
        onChangeText={setTitle}
        onEndEditing={saveTitle}
        style={styles.title}
        multiline
        submitBehavior="blurAndSubmit"
        returnKeyType="done"
        accessibilityLabel="Title"
        placeholder="Title"
        placeholderTextColor={theme.mutedForeground}
      />
      <View style={styles.chips}>
        <FieldButton label={row.project?.name ?? 'Unknown project'} />
        <FieldButton
          testID="task-status"
          label={statusLabel(task.status, row.project)}
          accessibilityLabel="Status"
          onPress={() => setOpen('status')}
        />
        <FieldButton
          testID="task-priority"
          label={priorityLabel(task.priority)}
          accessibilityLabel="Priority"
          onPress={() => setOpen('priority')}
        />
        <FieldButton
          testID="task-due"
          label={dueLabel(task.due_date ?? null, today)}
          accessibilityLabel="Due date"
          onPress={() => setOpen('due')}
        />
        {showHub ? <FieldButton label={row.hubLabel} /> : null}
      </View>
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
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    fields: { gap: 12 },
    title: { fontSize: 22, fontWeight: '600', color: t.foreground, padding: 0 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }
  })
