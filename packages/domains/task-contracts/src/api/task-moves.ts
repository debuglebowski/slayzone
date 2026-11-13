import { z } from 'zod'

/**
 * Moving tasks to a project on ANOTHER hub. The app (the only party connected to
 * both hubs) runs the move as a series of steps; the hub the tasks leave keeps the
 * journal (`task_moves`), so a paused or interrupted move resumes from any device.
 * Every step is safe to run again. While a move is running, paused or failed, its
 * tasks are locked: their writes are refused.
 */
export const TASK_MOVE_STEPS = [
  /** Lock the tasks and stop their agents (done when the move begins). */
  'lock',
  /** Read the tasks' rows and file manifest from the source hub. */
  'export',
  /** Write the rows into the target project (ids kept). */
  'import',
  /** Copy the artifact files, checked by hash. */
  'copy-files',
  /** Copy the agent sessions (chats, session ledger) from the tasks' computers to the target's. */
  'copy-sessions',
  /** Blockers between a moved task and one staying behind become cross-hub links. */
  'links',
  /** The target hub takes the tasks as its own. */
  'commit',
  /** The source hub lets the tasks go (rows removed, redirects left). */
  'release'
] as const
export type TaskMoveStep = (typeof TASK_MOVE_STEPS)[number]

/** The step after `step`, or null after the last one. */
export function nextTaskMoveStep(step: TaskMoveStep): TaskMoveStep | null {
  const i = TASK_MOVE_STEPS.indexOf(step)
  return i >= 0 && i + 1 < TASK_MOVE_STEPS.length ? TASK_MOVE_STEPS[i + 1] : null
}

export const TASK_MOVE_STATUSES = ['running', 'paused', 'failed', 'canceled', 'done'] as const
export type TaskMoveStatus = (typeof TASK_MOVE_STATUSES)[number]
/** A move in these states holds its tasks' lock. */
export const TASK_MOVE_LOCKING_STATUSES: readonly TaskMoveStatus[] = ['running', 'paused', 'failed']

/** What a move carries: tasks into an existing project, or a whole project (its id kept). */
export const TASK_MOVE_SCOPES = ['task', 'project'] as const
export type TaskMoveScope = (typeof TASK_MOVE_SCOPES)[number]

export interface TaskMove {
  id: string
  direction: 'out' | 'in'
  scope: TaskMoveScope
  /** A project move: the project (the same id on both hubs, so also `targetProjectId`). */
  projectId: string | null
  /** The other hub: where the tasks go ('out'), or where they come from ('in'). */
  peerHubId: string
  targetProjectId: string
  /** The tasks the user picked. */
  rootTaskIds: string[]
  /** Every task the move carries (the roots and, if brought, their subtasks). */
  taskIds: string[]
  includeSubtasks: boolean
  /** The tasks' agent sessions travel with them (else the tasks start fresh on the target). */
  includeSessions: boolean
  /** The step to run next (the last one finished: status 'done'). */
  step: TaskMoveStep
  status: TaskMoveStatus
  error: string | null
  /** The running step's progress, e.g. bytes copied. */
  progress: { step: TaskMoveStep; done: number; total: number } | null
  createdAt: number
  updatedAt: number
}

export const beginTaskMoveInputSchema = z.object({
  /** Client-chosen, so a retried begin is the same move. */
  id: z.string().uuid().optional(),
  taskIds: z.array(z.string().min(1)).min(1),
  targetHubId: z.string().min(1),
  targetProjectId: z.string().min(1),
  includeSubtasks: z.boolean().default(true),
  includeSessions: z.boolean().default(true)
})
export type BeginTaskMoveInput = z.input<typeof beginTaskMoveInputSchema>

/**
 * Move a whole project to another hub: every task in it (archived ones too) and the
 * project's own rows, all under one move. The project keeps its id on the target.
 */
export const beginProjectMoveInputSchema = z.object({
  /** Client-chosen, so a retried begin is the same move. */
  id: z.string().uuid().optional(),
  projectId: z.string().min(1),
  targetHubId: z.string().min(1),
  includeSessions: z.boolean().default(true)
})
export type BeginProjectMoveInput = z.input<typeof beginProjectMoveInputSchema>

export const taskMoveIdInputSchema = z.object({ id: z.string().min(1) })

export const advanceTaskMoveInputSchema = z.object({
  id: z.string().min(1),
  /** The step the caller finished. A move already past it is answered unchanged. */
  completed: z.enum(TASK_MOVE_STEPS)
})

export const reportTaskMoveProgressInputSchema = z.object({
  id: z.string().min(1),
  step: z.enum(TASK_MOVE_STEPS),
  done: z.number().int().min(0),
  total: z.number().int().min(0)
})

export const failTaskMoveInputSchema = z.object({
  id: z.string().min(1),
  error: z.string().min(1).max(2000)
})

export const listTaskMovesInputSchema = z
  .object({ statuses: z.array(z.enum(TASK_MOVE_STATUSES)).optional() })
  .default({})

export const taskMoveRedirectsInputSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(500)
})
/** Where moved tasks went: task id → the hub, by which move. A task not listed did not move away. */
export type TaskMoveRedirects = Record<string, { hubId: string; moveId: string }>

export const projectMoveRedirectsInputSchema = z.object({
  projectIds: z.array(z.string().min(1)).min(1).max(500)
})
/** Where moved projects went: project id → the hub, by which move. */
export type ProjectMoveRedirects = Record<string, { hubId: string; moveId: string }>

/**
 * What a move carries from hub to hub: the moved tasks' rows in every table that
 * holds task content on a hub. Ids are kept. Artifact bytes travel in their own step
 * (`copy-files`), which pins them on the target as it writes them. What a computer holds (sessions, chat,
 * scrollback) is not here; nor is hub↔computer delivery state, which the target
 * rebuilds for its own computers.
 */
export const TASK_MOVE_TABLES = [
  'tasks',
  'terminal_tabs',
  'task_tags',
  'task_dependencies',
  'artifact_folders',
  'task_artifacts',
  'artifact_versions',
  'activity_events',
  'usage_records'
] as const
export type TaskMoveTable = (typeof TASK_MOVE_TABLES)[number]

/**
 * The project's own rows a project move carries (its tasks travel as in any move).
 * Ids are kept. Left out, on purpose: automation run history, processes, chat CLI
 * caches, folder placements (the folder is offered to the target's computer instead),
 * group membership (the project arrives ungrouped). A project linked to an
 * integration does not move. `MOVE_DROPPED_TABLES` lists what is left behind, and why.
 */
export const PROJECT_MOVE_TABLES = [
  'projects',
  'tags',
  'automations',
  'task_templates',
  'test_categories',
  'test_labels',
  'test_file_labels',
  'test_file_notes',
  'ai_config_items',
  'ai_config_project_selections',
  'activity_events'
] as const
export type ProjectMoveTable = (typeof PROJECT_MOVE_TABLES)[number]

/**
 * Every other hub table holding a project's or a task's rows, and why a move between
 * hubs leaves it behind (`move-tables-classified.test.ts` fails on a table in neither
 * list). Chats travel in `copy-sessions` through the computers, not as hub rows.
 */
const LEGACY_CHAT =
  'legacy hub-held chat content: migrated to its computer, then copied by copy-sessions'
const DELIVERY =
  "hub-to-computer delivery or ownership state of the source hub's computers: the target rebuilds its own"
export const MOVE_DROPPED_TABLES: Readonly<Record<string, string>> = {
  // A project's
  automation_action_runs: 'automation run history: the automations move, their runs do not',
  processes: 'running processes belong to the source computers',
  chat_cli_snapshots: 'cache the target rebuilds',
  chat_cli_command_details: 'cache the target rebuilds',
  chat_cli_models: 'cache the target rebuilds',
  project_placements: "the source hub's computers; the folder is offered to the target's",
  integration_project_mappings: 'a linked project is refused',
  external_links: 'a linked task is refused',
  // Legacy chat storage
  chat_events: LEGACY_CHAT,
  chat_queue: LEGACY_CHAT,
  chat_tab_state: LEGACY_CHAT,
  chat_timeline_checkpoints: LEGACY_CHAT,
  chat_timeline_pages: LEGACY_CHAT,
  chat_threads: LEGACY_CHAT,
  chat_attachment_messages: LEGACY_CHAT,
  chat_workspace_changes: LEGACY_CHAT,
  // Delivery and ownership
  chat_ownership: DELIVERY,
  chat_tab_bindings: DELIVERY,
  chat_task_lifecycle: DELIVERY,
  chat_task_computers: DELIVERY,
  chat_lifecycle_acks: DELIVERY,
  chat_folder_deletions: DELIVERY,
  chat_folder_deletion_acks: DELIVERY,
  chat_folder_placeholders: DELIVERY,
  chat_legacy_task_authority: DELIVERY,
  chat_legacy_session_authority: DELIVERY,
  chat_legacy_tab_computers: DELIVERY,
  chat_provider_transitions: DELIVERY,
  session_resets: DELIVERY,
  session_deletions: DELIVERY,
  session_tab_recovery: DELIVERY,
  session_intent_acks: DELIVERY,
  computer_data_handoff: DELIVERY,
  item_faults: "faults of the source hub's own deliveries",
  artifact_blob_pins:
    "the source hub's blob pins: the target pins each blob as copy-files writes it",
  // The source hub's own move records
  task_moves: "the source hub's own journal",
  task_move_tasks: "the source hub's own journal",
  task_move_redirects: "the source hub's own redirects",
  task_move_parked_chats: "the source hub's own record of chats parked for a return",
  task_remote_blockers: 'links to tasks on other hubs, kept by each hub for its own side',
  project_move_redirects: "the source hub's own redirects"
}

export interface ProjectMoveBundle {
  projectId: string
  /** Rows per table, as the source stores them. `activity_events`: the project's own (no task). */
  rows: Record<ProjectMoveTable, Array<Record<string, unknown>>>
  /** Hub-wide settings whose key names the project. */
  settings: Array<{ key: string; value: string }>
  /** The mover's own per-user settings whose key names the project. */
  userSettings: Array<{ key: string; value: string }>
  /** The project's folder on the computer the source hub uses for it. */
  folder: string | null
}

export interface TaskMoveBundle {
  moveId: string
  /** A project move: the project's own rows. */
  project?: ProjectMoveBundle
  rootTaskIds: string[]
  /** Rows per table, as the source stores them (column → value). */
  rows: Record<TaskMoveTable, Array<Record<string, unknown>>>
  /** The tags `task_tags` names: the target uses its own of the same name, or makes one. */
  tags: Array<{ id: string; name: string; color: string; text_color: string }>
  /** Blockers between a moved task and one staying on the source (cross-hub links, 3d),
   *  with the staying task's title. */
  externalDependencies: Array<{ task_id: string; blocks_task_id: string; staying_title: string }>
}

export const exportTaskMoveInputSchema = z.object({ id: z.string().min(1) })

export const importTaskMoveInputSchema = z.object({
  /** The hub the tasks come from (the app's registry id). */
  sourceHubId: z.string().min(1),
  targetProjectId: z.string().min(1),
  /** The move carries the tasks' agent sessions: a canceled import forgets what it copied. */
  includeSessions: z.boolean().default(true),
  bundle: z.custom<TaskMoveBundle>(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as TaskMoveBundle).moveId === 'string' &&
      Array.isArray((v as TaskMoveBundle).rootTaskIds) &&
      typeof (v as TaskMoveBundle).rows === 'object'
  )
})
export type ImportTaskMoveInput = z.infer<typeof importTaskMoveInputSchema>

/**
 * A blocker between a task here and one on another hub (a move split them). `role`
 * is this task's side: it `blocks` the remote task, or is `blocked_by` it.
 */
export interface TaskRemoteBlocker {
  taskId: string
  role: 'blocks' | 'blocked_by'
  remoteHubId: string
  remoteTaskId: string
  /** The remote task's title when the link was made (for display). */
  remoteTitle: string | null
  createdAt: number
}

const remoteBlockerKey = {
  taskId: z.string().min(1),
  role: z.enum(['blocks', 'blocked_by']),
  remoteHubId: z.string().min(1),
  remoteTaskId: z.string().min(1)
}
export const addRemoteBlockersInputSchema = z.object({
  moveId: z.string().min(1),
  links: z.array(z.object({ ...remoteBlockerKey, remoteTitle: z.string().nullable() })).max(1000)
})
export const removeRemoteBlockerInputSchema = z.object(remoteBlockerKey)
export const remoteBlockersInputSchema = z.object({ taskId: z.string().min(1) })

/**
 * One chat of a moved task, as its source computer exports it (`copy-sessions`):
 * the transfer's manifest (its header names the conversation, its hash and size
 * check the bytes). The app relays it chunk by chunk; the computers verify it.
 */
export interface TaskMoveChatTransfer {
  /** The computer the chat is exported from. */
  computerId: string
  manifest: {
    header: {
      migrationId: string
      identity: { id: string; taskId: string; tabId: string; mode: string; epoch: number }
    } & Record<string, unknown>
    hash: string
    bytes: number
  }
}
/** What the source hub answers a task's session export with. */
export interface TaskMoveSessionsExport {
  transfers: TaskMoveChatTransfer[]
  /** The task's session ledger, merged over its computers (opaque to the app). */
  ledger: unknown
}
/** A chat's attachment, as the transfer's records name it. */
export interface TaskMoveAttachmentRef {
  artifactId: string
  contentHash: string
  name: string
  kind: string
  mediaType: string
  size: number
}
/**
 * A file beside a task's chats that a move copies (`copy-sessions`): a Claude session
 * transcript, a Codex rollout or a terminal's scrollback. The computers check each reference and hash.
 */
export type TaskMoveSessionFileRef =
  | { kind: 'claude-transcript'; sessionId: string }
  | { kind: 'codex-rollout'; sessionId: string; date: string; name: string }
  | { kind: 'pty-history'; name: string }
export interface TaskMoveSessionFile {
  ref: TaskMoveSessionFileRef
  size: number
  hash: string
  /** Source side: the computer that holds it. */
  computerId?: string
}
const sessionFileRef = z.custom<TaskMoveSessionFileRef>(
  (v) => typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string'
)
const sessionFileEntry = z.object({
  ref: sessionFileRef,
  size: z.number().int().min(0),
  hash: z.string().regex(/^[a-f0-9]{64}$/)
})
const sessionTask = { moveId: z.string().min(1), taskId: z.string().min(1) }
export const sessionsFilesInputSchema = z.object(sessionTask)
export const sessionsFileReadInputSchema = z.object({
  ...sessionTask,
  computerId: z.string().min(1),
  ref: sessionFileRef,
  offset: z.number().int().min(0),
  length: z.number().int().min(1).max(262144)
})
export const sessionsFilesMissingInputSchema = z.object({
  ...sessionTask,
  entries: z.array(sessionFileEntry).max(10_000)
})
export const sessionsFileWriteInputSchema = z.object({
  ...sessionTask,
  ref: sessionFileRef,
  offset: z.number().int().min(0),
  data: z.string().max(350000),
  complete: z
    .object({ size: z.number().int().min(0), hash: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional()
})
const transferManifest = z.custom<TaskMoveChatTransfer['manifest']>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as TaskMoveChatTransfer['manifest']).hash === 'string' &&
    typeof (v as TaskMoveChatTransfer['manifest']).bytes === 'number' &&
    typeof (v as TaskMoveChatTransfer['manifest']).header === 'object'
)
const attachmentRef = z.custom<TaskMoveAttachmentRef>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as TaskMoveAttachmentRef).artifactId === 'string'
)
export const sessionsExportInputSchema = z.object(sessionTask)
export const sessionsReadInputSchema = z.object({
  ...sessionTask,
  computerId: z.string().min(1),
  conversationId: z.string().min(1),
  offset: z.number().int().min(0),
  length: z.number().int().min(1).max(262144)
})
export const sessionsReadAttachmentInputSchema = z.object({
  ...sessionTask,
  computerId: z.string().min(1),
  conversationId: z.string().min(1),
  epoch: z.number().int().positive(),
  ref: attachmentRef
})
export const sessionsDiscardInputSchema = z.object({ moveId: z.string().min(1) })
export const sessionsBeginInputSchema = z.object({ ...sessionTask, manifest: transferManifest })
export const sessionsChunkInputSchema = z.object({
  ...sessionTask,
  transferId: z.string().min(1),
  offset: z.number().int().min(0),
  data: z.string().max(350000)
})
export const sessionsFinishInputSchema = z.object({ ...sessionTask, transferId: z.string().min(1) })
export const sessionsPutAttachmentInputSchema = z.object({
  ...sessionTask,
  conversationId: z.string().min(1),
  epoch: z.number().int().positive(),
  ref: attachmentRef,
  data: z.string().max(14_000_000)
})
export const sessionsActivateInputSchema = z.object({
  ...sessionTask,
  conversationId: z.string().min(1),
  migrationId: z.string().min(1),
  epoch: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/)
})
export const sessionsImportLedgerInputSchema = z.object({ ...sessionTask, ledger: z.unknown() })
export const sessionsRegisterInputSchema = z.object({
  ...sessionTask,
  chats: z
    .array(
      z.object({
        id: z.string().min(1),
        tabId: z.string().min(1),
        mode: z.string().min(1),
        epoch: z.number().int().positive()
      })
    )
    .max(1000)
})

/** What moving a project to another hub would carry — the dialog's summary. Writes nothing. */
export const projectMovePreviewInputSchema = z.object({ projectId: z.string().min(1) })
export interface ProjectMovePreview {
  /** Every task in the project, archived ones and subtasks included. */
  taskCount: number
  /** The project, or one of its tasks, is linked to an integration here: it cannot move. */
  linkedToIntegration: boolean
  /** A deletion of one of its tasks is still running: wait for it to finish. */
  deletionPending: boolean
  /** The project, or one of its tasks, is already being moved. */
  alreadyMoving: boolean
  /** Blockers to tasks in other projects: they become links between the hubs. */
  externalBlockerCount: number
}

/** What a move to another hub would carry — the move dialog's summary. Writes nothing. */
export const crossHubMovePreviewInputSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1)
})
export interface CrossHubMovePreview {
  /** Every subtask (any depth, archived included) of the picked tasks. */
  subtaskCount: number
  /** A task (or subtask) linked to an integration here: it cannot move to another hub. */
  linkedToIntegration: boolean
  /** Blockers to tasks that stay here: they become links between the hubs. */
  externalBlockerCount: number
  /** A task is already being moved. */
  alreadyMoving: boolean
}
