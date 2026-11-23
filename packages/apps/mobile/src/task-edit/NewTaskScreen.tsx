/**
 * Creating a task (`/new-task`, `routes.ts`): the title first and focused (dictation on
 * the keyboard is the voice input), then project (any signed-in hub's; fixed for a
 * subtask, which takes its parent's), status (the project's columns; the one the screen
 * was opened with, e.g. a column's "+"), priority, due date and template (the project's
 * default preselected; its status and priority fill what wasn't chosen, as desktop's
 * dialog). Creates on the hub that owns the project (`task.create`), and the hub applies
 * the template the way it does for desktop and the CLI; Return in the title creates too.
 * Created, the task is put on its hub's board at once (the full board reloads behind) and
 * opened. The due date: quick dates and iOS's calendar in one sheet (`DueDateSheet`).
 * Cancel with a typed title asks first (`confirmDiscardTask`; the route asks the same
 * on a swipe back, told by `onDirtyChange`).
 */
import { HubScope } from '@slayzone/transport/client'
import { todayISO } from '@slayzone/tasks/board'
import { getDefaultStatus, isKnownStatus } from '@slayzone/workflow'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { ChoiceSheet } from '../computers/ChoiceSheet'
import type { BoardData, BoardProject, HubFeed } from '../hub-board'
import { useHubFeeds } from '../hub-connections'
import { hubEntryOf } from '../hub-session'
import type { ProjectRow } from '../projects/hub-projects'
import { ProjectPicker } from '../projects/ProjectPicker'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPC, useTRPCClient } from '../trpc'
import { createTaskInput, type NewTaskDraft } from './create'
import { DueDateSheet } from './DueDateSheet'
import {
  applyTemplate,
  dueLabel,
  NO_TEMPLATE,
  PRIORITY_CHOICES,
  priorityLabel,
  statusChoices,
  statusLabel,
  templateChoices
} from './fields'
import { FieldButton } from './ui'
import { messageOf } from './use-task-writes'

const DEFAULT_PRIORITY = 3

/** Asks before a typed task is thrown away (Cancel, or the route's swipe back). */
export function confirmDiscardTask(onDiscard: () => void, creating = false): void {
  const message = creating
    ? 'The hub may still create this task. Leave this screen?'
    : 'What you typed is not saved.'
  Alert.alert(creating ? 'Leave while creating?' : 'Discard this task?', message, [
    { text: 'Keep editing', style: 'cancel' },
    { text: creating ? 'Leave' : 'Discard', style: 'destructive', onPress: onDiscard }
  ])
}

export interface NewTaskScreenProps {
  /** The hub's address (as in a task's route). */
  hubAddress: string
  projectId: string
  /** The status to start with; one the project doesn't have is ignored. */
  status?: string
  /** The priority to start with (1 Urgent … 5 Someday; a board's priority group). */
  priority?: number
  /** The due date to start with (YYYY-MM-DD; a board's due-date group). */
  dueDate?: string
  /** Creates a subtask of this task (same hub and project). */
  parentId?: string
  onCreated: (hubAddress: string, taskId: string) => void
  /** Cancel (after asking, when a title was typed). */
  onCancel: () => void
  /** Whether leaving now would throw away a typed title (the route guards swipe back). */
  onDirtyChange?: (dirty: boolean, creating: boolean) => void
}

function feedOfAddress(feeds: readonly HubFeed[], address: string): HubFeed | undefined {
  let id: string
  try {
    id = hubEntryOf(address).id
  } catch {
    return undefined
  }
  return feeds.find((f) => f.hub.id === id)
}

const projectIn = (feed: HubFeed | undefined, projectId: string): BoardProject | undefined =>
  feed?.board.data?.projects.find((p) => p?.id === projectId) ?? undefined

type Open = 'project' | 'status' | 'priority' | 'due' | 'template' | null

/** What the form starts from: the draft, and which fields the user chose. */
interface FormState {
  hubId: string
  draft: NewTaskDraft
  /** Fields the user chose (or the screen was opened with): a template leaves them. */
  explicit: { status: boolean; priority: boolean }
}

export function NewTaskScreen(props: NewTaskScreenProps) {
  const styles = makeStyles(useTheme())
  const { feeds } = useHubFeeds()
  // The form, per hub: a project on another hub remounts it in that hub's scope, carrying
  // what was typed and chosen.
  const [form, setForm] = useState<FormState | null>(() => {
    const opened = feedOfAddress(feeds, props.hubAddress)
    if (!opened) return null
    const columns = projectIn(opened, props.projectId)?.columns_config
    const priority = [1, 2, 3, 4, 5].find((p) => p === props.priority)
    const status =
      props.status && isKnownStatus(props.status, columns)
        ? props.status
        : getDefaultStatus(columns)
    return {
      hubId: opened.hub.id,
      draft: {
        projectId: props.projectId,
        parentId: props.parentId ?? null,
        title: '',
        status,
        priority: priority ?? DEFAULT_PRIORITY,
        dueDate: props.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(props.dueDate) ? props.dueDate : null,
        templateId: NO_TEMPLATE
      },
      explicit: { status: status === props.status, priority: priority !== undefined }
    }
  })
  const feed = form ? feeds.find((f) => f.hub.id === form.hubId) : undefined

  if (!form || !feed) {
    return (
      <View style={styles.screen}>
        <Header onCancel={props.onCancel} />
        <Text style={styles.note}>Not signed in to {props.hubAddress}</Text>
      </View>
    )
  }
  return (
    <View style={styles.screen}>
      <HubScope hubId={form.hubId} key={form.hubId}>
        <NewTaskForm
          feed={feed}
          initial={form}
          onMoveHub={setForm}
          onCreated={props.onCreated}
          onCancel={props.onCancel}
          onDirtyChange={props.onDirtyChange}
        />
      </HubScope>
    </View>
  )
}

function NewTaskForm({
  feed,
  initial,
  onMoveHub,
  onCreated,
  onCancel,
  onDirtyChange
}: {
  feed: HubFeed
  initial: FormState
  onMoveHub: (form: FormState) => void
  onCreated: NewTaskScreenProps['onCreated']
  onCancel: () => void
  onDirtyChange?: (dirty: boolean, creating: boolean) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(initial.draft)
  const [explicit, setExplicit] = useState(initial.explicit)
  const [open, setOpen] = useState<Open>(null)
  const [creating, setCreating] = useState(false)
  const submitting = useRef(false)
  const abandoned = useRef(false)
  useLayoutEffect(() => {
    abandoned.current = false
    return () => {
      abandoned.current = true
    }
  }, [])
  const [error, setError] = useState<string | null>(null)
  const project = projectIn(feed, draft.projectId)
  const parent = draft.parentId
    ? feed.board.data?.tasks.find((t) => t.id === draft.parentId)
    : undefined
  const today = todayISO()
  const set = (fields: Partial<NewTaskDraft>) => setDraft((d) => ({ ...d, ...fields }))
  const dirty = draft.title.trim() !== ''
  useEffect(() => onDirtyChange?.(dirty, creating), [dirty, creating, onDirtyChange])
  const cancel = () => {
    const leave = () => {
      abandoned.current = true
      onCancel()
    }
    if (dirty || submitting.current) confirmDiscardTask(leave, submitting.current)
    else leave()
  }

  const input = createTaskInput(draft)
  // Creates on the scope's hub; the created task goes on that hub's board at once (the
  // task screen finds it there) while the whole board reloads behind, then it opens.
  const create = () => {
    if (!input || submitting.current) return
    submitting.current = true
    setCreating(true)
    setError(null)
    client.task.create
      .mutate(input)
      .then((task) => {
        queryClient.setQueryData(
          trpc.task.loadBoardData.queryKey(),
          (board: BoardData | undefined) =>
            board && !board.tasks.some((t) => t.id === task.id)
              ? { ...board, tasks: [...board.tasks, task] }
              : board
        )
        void queryClient.invalidateQueries(trpc.task.loadBoardData.queryFilter())
        submitting.current = false
        if (abandoned.current) return
        setCreating(false)
        setDraft((draft) => ({ ...draft, title: '' }))
        onCreated(feed.hub.label, task.id)
      })
      .catch((err: unknown) => {
        submitting.current = false
        if (abandoned.current) return
        setCreating(false)
        setError(`Couldn't create the task: ${messageOf(err)}`)
      })
  }

  // The project's templates (on its hub); once they arrive, its default is preselected
  // and fills status and priority (render-time: the draft is this component's).
  const templatesQ = useQuery(
    trpc.template.getByProject.queryOptions({ projectId: draft.projectId })
  )
  const templates = templatesQ.data ?? []
  const { choices: templateList, initial: defaultTemplate } = templateChoices(templates)
  const [templatesFor, setTemplatesFor] = useState<string | null>(null)
  if (templatesQ.data && templatesFor !== draft.projectId) {
    setTemplatesFor(draft.projectId)
    setDraft((d) => ({
      ...d,
      templateId: defaultTemplate,
      ...applyTemplate(
        d,
        templates.find((t) => t.id === defaultTemplate),
        project?.columns_config,
        explicit
      )
    }))
  }
  const chooseTemplate = (templateId: string) =>
    setDraft((d) => ({
      ...d,
      templateId,
      ...applyTemplate(
        d,
        templates.find((t) => t.id === templateId),
        project?.columns_config,
        explicit
      )
    }))

  const chooseProject = (row: ProjectRow) => {
    const columns = row.project.columns_config
    const next: NewTaskDraft = {
      ...draft,
      projectId: row.project.id,
      status: isKnownStatus(draft.status, columns) ? draft.status : getDefaultStatus(columns),
      templateId: NO_TEMPLATE
    }
    if (row.hubId !== feed.hub.id) onMoveHub({ hubId: row.hubId, draft: next, explicit })
    else setDraft(next)
  }

  return (
    <>
      <Header onCancel={cancel}>
        <CreateButton disabled={!input} creating={creating} onCreate={create} />
      </Header>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <TextInput
          testID="new-task-title"
          editable={!creating}
          value={draft.title}
          onChangeText={(title) => set({ title })}
          autoFocus
          multiline
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
          onSubmitEditing={create}
          placeholder="Task title"
          placeholderTextColor={theme.mutedForeground}
          style={styles.title}
          accessibilityLabel="Title"
        />
        {parent ? <Text style={styles.note}>Subtask of {parent.title}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.fields}>
          <Field label="Project">
            <FieldButton
              testID="new-task-project"
              label={project?.name ?? 'Choose a project'}
              accessibilityLabel={`Project: ${project?.name ?? 'none chosen'}`}
              onPress={draft.parentId || creating ? undefined : () => setOpen('project')}
            />
          </Field>
          <Field label="Status">
            <FieldButton
              testID="new-task-status"
              label={statusLabel(draft.status, project)}
              accessibilityLabel={`Status: ${statusLabel(draft.status, project)}`}
              onPress={creating ? undefined : () => setOpen('status')}
            />
          </Field>
          <Field label="Priority">
            <FieldButton
              testID="new-task-priority"
              label={priorityLabel(draft.priority)}
              accessibilityLabel={`Priority: ${priorityLabel(draft.priority)}`}
              onPress={creating ? undefined : () => setOpen('priority')}
            />
          </Field>
          <Field label="Due">
            <FieldButton
              testID="new-task-due"
              label={dueLabel(draft.dueDate, today)}
              accessibilityLabel={`Due: ${dueLabel(draft.dueDate, today)}`}
              onPress={creating ? undefined : () => setOpen('due')}
            />
          </Field>
          {templateList.length > 0 ? (
            <Field label="Template">
              <FieldButton
                testID="new-task-template"
                label={templateList.find((c) => c.key === draft.templateId)?.label ?? 'No template'}
                accessibilityLabel={`Template: ${templateList.find((c) => c.key === draft.templateId)?.label ?? 'No template'}`}
                onPress={creating ? undefined : () => setOpen('template')}
              />
            </Field>
          ) : null}
        </View>
      </ScrollView>
      <ProjectPicker
        visible={open === 'project'}
        selected={{ hubId: feed.hub.id, projectId: draft.projectId }}
        onSelect={chooseProject}
        onClose={() => setOpen(null)}
      />
      <ChoiceSheet
        visible={open === 'status'}
        title="Status"
        choices={statusChoices(project)}
        selectedKey={draft.status}
        onChoose={(status) => {
          setExplicit((e) => ({ ...e, status: true }))
          set({ status })
        }}
        onClose={() => setOpen(null)}
      />
      <ChoiceSheet
        visible={open === 'priority'}
        title="Priority"
        choices={PRIORITY_CHOICES}
        selectedKey={String(draft.priority)}
        onChoose={(key) => {
          setExplicit((e) => ({ ...e, priority: true }))
          set({ priority: Number(key) })
        }}
        onClose={() => setOpen(null)}
      />
      <DueDateSheet
        visible={open === 'due'}
        value={draft.dueDate}
        today={today}
        onChoose={(dueDate) => set({ dueDate })}
        onClose={() => setOpen(null)}
      />
      <ChoiceSheet
        visible={open === 'template'}
        title="Template"
        choices={templateList}
        selectedKey={draft.templateId}
        onChoose={chooseTemplate}
        onClose={() => setOpen(null)}
      />
    </>
  )
}

function Header({ onCancel, children }: { onCancel: () => void; children?: ReactNode }) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.header}>
      <Pressable onPress={onCancel} hitSlop={12} accessibilityRole="button">
        <Text style={styles.link}>Cancel</Text>
      </Pressable>
      <Text style={styles.heading}>New task</Text>
      {children}
    </View>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.field}>
      {/* The field's button reads its name with its value. */}
      <Text style={styles.fieldLabel} accessibilityElementsHidden importantForAccessibility="no">
        {label}
      </Text>
      {children}
    </View>
  )
}

/** Create (the header's): `onCreate` does it; a spinner while it runs. */
function CreateButton({
  disabled,
  creating,
  onCreate
}: {
  disabled: boolean
  creating: boolean
  onCreate: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  return creating ? (
    <ActivityIndicator color={theme.mutedForeground} />
  ) : (
    <Pressable onPress={onCreate} hitSlop={12} accessibilityRole="button" disabled={disabled}>
      <Text style={[styles.link, styles.create, disabled && styles.disabled]}>Create</Text>
    </Pressable>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    heading: { flex: 1, fontSize: 17, fontWeight: '600', color: t.foreground, textAlign: 'center' },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    create: { fontWeight: '700' },
    disabled: { color: t.mutedForeground },
    body: { padding: 20, gap: 16 },
    title: { fontSize: 22, fontWeight: '600', color: t.foreground, padding: 0 },
    fields: { gap: 12 },
    field: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    fieldLabel: { width: 72, fontSize: 13, color: t.mutedForeground },
    note: { fontSize: 13, color: t.mutedForeground, padding: 0 },
    error: { fontSize: 13, color: t.destructive }
  })
