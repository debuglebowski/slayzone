/**
 * Creating a task (`/new-task`, `routes.ts`): the title first and focused (dictation on
 * the keyboard is the voice input), then project (any signed-in hub's; fixed for a
 * subtask, which takes its parent's), status (the project's columns; the one the screen
 * was opened with, e.g. a column's "+"), priority, due date and template (the project's
 * default preselected; its status and priority fill what wasn't chosen, as desktop's
 * dialog). Creates on the hub that owns the project (`task.create`), and the hub applies
 * the template the way it does for desktop and the CLI.
 */
import { HubScope } from '@slayzone/transport/client'
import { todayISO } from '@slayzone/tasks/board'
import { getDefaultStatus, isKnownStatus } from '@slayzone/workflow'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { ChoiceSheet } from '../computers/ChoiceSheet'
import type { BoardProject, HubFeed } from '../hub-board'
import { useHubFeeds } from '../hub-connections'
import { hubEntryOf } from '../hub-session'
import type { ProjectRow } from '../projects/hub-projects'
import { ProjectPicker } from '../projects/ProjectPicker'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPC, useTRPCClient } from '../trpc'
import { createTaskInput, type NewTaskDraft } from './create'
import {
  applyTemplate,
  dueChoices,
  dueLabel,
  NO_TEMPLATE,
  parseDueDate,
  PRIORITY_CHOICES,
  priorityLabel,
  statusChoices,
  statusLabel,
  templateChoices
} from './fields'
import { FieldButton, PromptSheet } from './ui'
import { messageOf } from './use-task-writes'

const PICK_DATE = 'pick'
const DEFAULT_PRIORITY = 3

export interface NewTaskScreenProps {
  /** The hub's address (as in a task's route). */
  hubAddress: string
  projectId: string
  /** The status to start with; one the project doesn't have is ignored. */
  status?: string
  /** Creates a subtask of this task (same hub and project). */
  parentId?: string
  onCreated: (hubAddress: string, taskId: string) => void
  onCancel: () => void
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

type Open = 'project' | 'status' | 'priority' | 'due' | 'date' | 'template' | null

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
        priority: DEFAULT_PRIORITY,
        dueDate: null,
        templateId: NO_TEMPLATE
      },
      explicit: { status: status === props.status, priority: false }
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
  onCancel
}: {
  feed: HubFeed
  initial: FormState
  onMoveHub: (form: FormState) => void
  onCreated: NewTaskScreenProps['onCreated']
  onCancel: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const [draft, setDraft] = useState(initial.draft)
  const [explicit, setExplicit] = useState(initial.explicit)
  const [open, setOpen] = useState<Open>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const project = projectIn(feed, draft.projectId)
  const parent = draft.parentId
    ? feed.board.data?.tasks.find((t) => t.id === draft.parentId)
    : undefined
  const today = todayISO()
  const set = (fields: Partial<NewTaskDraft>) => setDraft((d) => ({ ...d, ...fields }))

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

  const dues = dueChoices(today)
  return (
    <>
      <Header onCancel={onCancel}>
        <CreateButton
          draft={draft}
          hubAddress={feed.hub.label}
          creating={creating}
          setCreating={setCreating}
          setError={setError}
          onCreated={onCreated}
        />
      </Header>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <TextInput
          testID="new-task-title"
          value={draft.title}
          onChangeText={(title) => set({ title })}
          autoFocus
          multiline
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
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
              onPress={draft.parentId ? undefined : () => setOpen('project')}
            />
          </Field>
          <Field label="Status">
            <FieldButton
              testID="new-task-status"
              label={statusLabel(draft.status, project)}
              onPress={() => setOpen('status')}
            />
          </Field>
          <Field label="Priority">
            <FieldButton
              testID="new-task-priority"
              label={priorityLabel(draft.priority)}
              onPress={() => setOpen('priority')}
            />
          </Field>
          <Field label="Due">
            <FieldButton
              testID="new-task-due"
              label={dueLabel(draft.dueDate, today)}
              onPress={() => setOpen('due')}
            />
          </Field>
          {templateList.length > 0 ? (
            <Field label="Template">
              <FieldButton
                testID="new-task-template"
                label={templateList.find((c) => c.key === draft.templateId)?.label ?? 'No template'}
                onPress={() => setOpen('template')}
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
      <ChoiceSheet
        visible={open === 'due'}
        title="Due date"
        choices={[...dues, { key: PICK_DATE, label: 'Pick a date…' }]}
        selectedKey={dues.find((d) => d.date === draft.dueDate)?.key ?? null}
        onChoose={(key) => {
          if (key === PICK_DATE) setOpen('date')
          else set({ dueDate: dues.find((d) => d.key === key)?.date ?? null })
        }}
        onClose={() => setOpen((o) => (o === 'due' ? null : o))}
      />
      <ChoiceSheet
        visible={open === 'template'}
        title="Template"
        choices={templateList}
        selectedKey={draft.templateId}
        onChoose={chooseTemplate}
        onClose={() => setOpen(null)}
      />
      {open === 'date' ? (
        <PromptSheet
          visible
          title="Due date"
          placeholder="YYYY-MM-DD"
          submitLabel="Set"
          inputTestID="due-date-input"
          initial={draft.dueDate ?? ''}
          validate={(text) => (parseDueDate(text) ? null : 'Type a date as YYYY-MM-DD')}
          onSubmit={(text) => set({ dueDate: parseDueDate(text) })}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  )
}

function Header({ onCancel, children }: { onCancel: () => void; children?: ReactNode }) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.header}>
      <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
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
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  )
}

/** Creates on the scope's hub, waits for its board to carry the task, then opens it. */
function CreateButton({
  draft,
  hubAddress,
  creating,
  setCreating,
  setError,
  onCreated
}: {
  draft: NewTaskDraft
  hubAddress: string
  creating: boolean
  setCreating: (creating: boolean) => void
  setError: (error: string | null) => void
  onCreated: (hubAddress: string, taskId: string) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const input = createTaskInput(draft)
  const create = () => {
    if (!input || creating) return
    setCreating(true)
    setError(null)
    client.task.create
      .mutate(input)
      .then((task) =>
        // The task screen finds the task in the board: load it before opening.
        queryClient
          .invalidateQueries(trpc.task.loadBoardData.queryFilter())
          .then(() => onCreated(hubAddress, task.id))
      )
      .catch((err: unknown) => {
        setCreating(false)
        setError(`Couldn't create the task: ${messageOf(err)}`)
      })
  }
  return creating ? (
    <ActivityIndicator color={theme.mutedForeground} />
  ) : (
    <Pressable onPress={create} hitSlop={8} accessibilityRole="button" disabled={!input}>
      <Text style={[styles.link, styles.create, !input && styles.disabled]}>Create</Text>
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
