/**
 * Start a task's MAIN agent on the hub (`task.startMainAgent`).
 *
 * Spawning used to be client-driven: the desktop terminal resolves the spawn props
 * and cwd itself and calls `pty.create` when `pty.attach` says nothing runs — and
 * `createPty` kills and replaces a live session, so two clients doing that race and
 * kill each other's agent. Here the hub resolves everything from what it stores, the
 * same way the desktop does (`../shared/main-terminal`, one implementation), and
 * starts the agent only when none is live:
 *
 *   - a live session is answered, never replaced;
 *   - concurrent calls for one task share one start (single flight);
 *   - terminal agents start through the `pty.create` op, chat agents through
 *     `chat.start` (hydrate + spawn) — exactly what the desktop calls.
 *
 * Repo discovery runs on the machine the task's agent runs on (the routed workspace
 * fs), through a seam api wires: worktrees owns `detectChildRepos` and builds on this
 * package, so it cannot be imported here.
 */
import { randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import type { SlayzoneDb } from '@slayzone/platform'
import type { Task, UpdateTaskInput } from '@slayzone/task-contracts'
import { getProviderFlags } from '@slayzone/task-contracts/types'
import type { DetectedRepo } from '@slayzone/projects-contracts'
import { parseProject } from '@slayzone/projects/server'
import { getRuntimeAdapters, readTaskPaths } from './ops/shared'
import { resetConversation } from './ops/task-conversations'
import { ensureMainTab } from '@slayzone/task-terminals/server'
import { getChatDeps, getPtyDeps } from '@slayzone/terminal/hub'
import {
  isChatSupported,
  spawnConversationIds,
  type ChatCreateOpts,
  type TerminalState
} from '@slayzone/terminal-contracts'
import {
  hasOwnFolder,
  mainTerminalCwd,
  mainTerminalCwdNeedsRepos,
  mainTerminalProps,
  type MainTerminalProps
} from '../shared/main-terminal'

export type MainAgentDeps = {
  /**
   * The project's child repos (multi-repo "wrapper" projects), discovered on the
   * machine `target` resolves to — the task's computer, where its agent runs.
   */
  detectChildRepos: (target: { taskId: string }, projectPath: string) => Promise<DetectedRepo[]>
}

let deps: MainAgentDeps | null = null

export function setMainAgentDeps(next: MainAgentDeps): void {
  deps = next
}

export interface StartMainAgentInput {
  taskId: string
  /** Terminal size to start a terminal agent at; omitted = the runtime default. */
  cols?: number
  rows?: number
  /**
   * The computer's admission lane: `foreground` (default) = someone asked for it
   * now; `restore` = the hub bringing back what ran at shutdown — it starts after
   * every foreground start (`computer/spawn-admission.ts`).
   */
  admission?: 'foreground' | 'restore'
  /**
   * Start only an agent of this kind; a task whose main agent is the other kind is
   * left alone (answered `started: false`). The boot restore starts chat agents only.
   */
  kind?: 'pty' | 'chat'
}

export interface StartMainAgentResult {
  /** The main tab's session id (`${taskId}:${tabId}`), as every `pty.*` / chat event keys it. */
  sessionId: string
  /** The main tab (its id is the task id). */
  tabId: string
  mode: string
  /** `chat`: a chat tab (`chat.*`); `pty`: a terminal agent (`pty.*`). */
  kind: 'pty' | 'chat'
  /** The folder this call started the agent in (resolved on the hub); null when it
   *  found one already live — it resolves nothing then. */
  cwd: string | null
  /** The session's state after this call; null when the runtime has none to report. */
  state: TerminalState | null
  /** True when THIS call started the agent; false when one was already live (or
   *  another concurrent call started it). */
  started: boolean
}

/** One start per task at a time: later callers join it (see `startMainAgent`). */
const inFlight = new Map<string, Promise<StartMainAgentResult>>()

/**
 * Start `taskId`'s main agent unless one is live. Idempotent: a call while it runs
 * answers the live session; a concurrent call joins the one in flight.
 */
export function startMainAgent(
  db: SlayzoneDb,
  input: StartMainAgentInput,
  getTask: (taskId: string) => Promise<Task | null>
): Promise<StartMainAgentResult> {
  const pending = inFlight.get(input.taskId)
  if (pending) return pending.then((r) => ({ ...r, started: false }))
  // Registered before the first await, so no second caller can slip past the check.
  const run = startOnce(db, input, getTask).finally(() => inFlight.delete(input.taskId))
  inFlight.set(input.taskId, run)
  return run
}

/**
 * Everything needed to start (or address) `taskId`'s main agent, resolved from what
 * the hub stores — ONE derivation for `startMainAgent` and the REST agent/chat
 * routes. Ensures the main tab row (it follows the task's mode). The folder is
 * resolved on demand (`resolveCwd`): it may run repo discovery on the task's computer.
 */
export interface MainAgentLaunch {
  taskId: string
  /** The main tab (its id is the task id). */
  tabId: string
  /** `${taskId}:${tabId}`, as every `pty.*` / chat event keys it. */
  sessionId: string
  mode: string
  kind: 'pty' | 'chat'
  props: MainTerminalProps
  /** What the desktop's main chat tab passes as `providerFlagsOverride`. */
  providerFlagsOverride: string | null
  /** The folder the agent runs in; throws PRECONDITION_FAILED when the task has none. */
  resolveCwd(): Promise<string>
}

export async function resolveMainAgentLaunch(
  db: SlayzoneDb,
  taskId: string,
  getTask: (taskId: string) => Promise<Task | null>
): Promise<MainAgentLaunch> {
  const task = await getTask(taskId)
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
  const project = parseProject(
    await db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [task.project_id])
  )
  const pty = getPtyDeps().ops
  const props = mainTerminalProps(task, project, await pty.agentsList())
  // The main tab follows the task's mode, as the desktop's `taskTerminals.ensureMain`.
  const tab = await ensureMainTab(db, taskId, props.mode)
  return {
    taskId,
    tabId: tab.id,
    sessionId: `${taskId}:${tab.id}`,
    mode: props.mode,
    kind: isChatSupported(props.mode) ? 'chat' : 'pty',
    props,
    providerFlagsOverride: props.providerFlags ?? null,
    resolveCwd: () => resolveTaskAgentCwd(db, task, project)
  }
}

/** Resolve a scoped chat launch from stored task/tab state, never client launch options. */
export async function resolveChatAgentLaunch(
  db: SlayzoneDb,
  { taskId, tabId }: { taskId: string; tabId: string },
  getTask: (taskId: string) => Promise<Task | null>
): Promise<ChatCreateOpts> {
  const tab = await db.get<{ task_id: string; mode: string; is_main: number }>(
    'SELECT task_id,mode,is_main FROM terminal_tabs WHERE id=?',
    [tabId]
  )
  if (!tab || tab.task_id !== taskId)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' })
  const task = await getTask(taskId)
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' })
  const mode = tab.is_main ? task.agent_id : tab.mode
  const agent = (await getPtyDeps().ops.agentsList()).find((a) => a.id === mode)
  if (!isChatSupported(mode) || !agent?.enabled) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Select an enabled chat agent for this tab'
    })
  }
  const project = parseProject(
    await db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [task.project_id])
  )
  return {
    tabId,
    taskId,
    mode,
    cwd: await resolveTaskAgentCwd(db, task, project),
    providerFlagsOverride: tab.is_main ? getProviderFlags(task.provider_config, mode) : null
  }
}

async function resolveTaskAgentCwd(
  db: SlayzoneDb,
  task: Task,
  project: ReturnType<typeof parseProject>
): Promise<string> {
  const projectRoot = await getRuntimeAdapters().projectRootForTask(db, task.id, task.project_id)
  const detected = mainTerminalCwdNeedsRepos(task, project, projectRoot)
    ? await detectChildRepos(task.id, projectRoot!)
    : []
  // A worktree / custom folder is read from the task's computer (§9 Phase 7d).
  const paths = hasOwnFolder(task) ? (await readTaskPaths([task.id]))[task.id] : null
  if (paths?.state === 'offline')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: "This task's folder is on a computer that is not connected"
    })
  const cwd = mainTerminalCwd(task, project, projectRoot, detected, paths)
  if (!cwd)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: "This task has no folder to run in: set the project's folder or the task's base dir"
    })
  return cwd
}

async function startOnce(
  db: SlayzoneDb,
  { taskId, cols, rows, admission = 'foreground', kind: onlyKind }: StartMainAgentInput,
  getTask: (taskId: string) => Promise<Task | null>
): Promise<StartMainAgentResult> {
  const launch = await resolveMainAgentLaunch(db, taskId, getTask)
  const { sessionId, kind, props } = launch
  const pty = getPtyDeps().ops
  const base = { sessionId, tabId: launch.tabId, mode: launch.mode, kind } as const
  if (onlyKind && kind !== onlyKind) return { ...base, cwd: null, state: null, started: false }

  // Live already: answer it. Starting again would replace it — a pty create kills
  // the session at this id; a chat hydrate with any other cwd tears the tab down.
  const live = await liveState(kind, sessionId)
  if (live) return { ...base, cwd: null, state: live, started: false }

  const cwd = await launch.resolveCwd()

  if (kind === 'chat') {
    await getChatDeps().ops.start({
      tabId: launch.tabId,
      taskId,
      mode: props.mode,
      cwd,
      // What the desktop's main chat tab passes (`pane.providerFlags ?? null`).
      providerFlagsOverride: launch.providerFlagsOverride,
      // `user` = the computer's foreground admission lane; `restore` = after it.
      reason: admission === 'restore' ? 'restore' : 'user'
    })
  } else {
    const ids = spawnConversationIds(
      {
        mode: props.mode,
        supportsSessionId: props.supportsSessionId,
        conversationId: undefined,
        existingConversationId: undefined
      },
      randomUUID
    )
    const result = await pty.ptyCreate({
      sessionId,
      cwd,
      conversationId: ids.conversationId,
      existingConversationId: ids.existingConversationId,
      mode: props.mode,
      providerFlags: props.providerFlags,
      executionContext: props.executionContext,
      cols,
      rows,
      // Asked for now: starts ahead of agents a workspace restore queued.
      foreground: admission !== 'restore'
    })
    if (!result.success) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: result.error ?? 'The agent could not be started'
      })
    }
  }
  return { ...base, cwd, state: (await pty.sessionGetState(sessionId)) ?? null, started: true }
}

/** The live session's state, or null when none runs at `sessionId`. */
async function liveState(kind: 'pty' | 'chat', sessionId: string): Promise<TerminalState | null> {
  const pty = getPtyDeps().ops
  if (kind === 'pty') {
    if (!(await pty.ptyExists(sessionId))) return null
    return (await pty.ptyGetState(sessionId)) ?? 'running'
  }
  // `chatList` lists chat tabs with a process (not ended, not a never-started skeleton).
  const chat = (await pty.chatList()).find((c) => c.sessionId === sessionId)
  return chat && chat.state !== 'dead' ? chat.state : null
}

export interface SwitchMainAgentModeInput {
  taskId: string
  /** An `agents` id (`claude-code`, `codex`, `claude-chat`, …). */
  mode: string
}

/**
 * Switch `taskId`'s main agent to another mode — ONE implementation for desktop,
 * mobile and the CLI (`slay tasks update --agent`). Stops the live main agent (the
 * chat process for a chat mode, else the pty), then stores the new mode with every
 * conversation id cleared: a mode switch starts fresh. It does not start the new
 * agent — the desktop's remounted terminal / `task.startMainAgent` does.
 *
 * Same mode = no-op. Unknown or disabled mode = BAD_REQUEST naming the enabled ones.
 * `update` is the caller's `updateTaskOp` binding (its event bus + mutation hook).
 */
export async function switchMainAgentMode(
  db: SlayzoneDb,
  { taskId, mode }: SwitchMainAgentModeInput,
  io: {
    getTask: (taskId: string) => Promise<Task | null>
    update: (input: UpdateTaskInput) => Promise<Task | null>
  }
): Promise<Task> {
  const task = await io.getTask(taskId)
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
  if (task.agent_id === mode) return task

  const modes = await getPtyDeps().ops.agentsList()
  const target = modes.find((m) => m.id === mode)
  if (!target || !target.enabled) {
    const enabled = modes.filter((m) => m.enabled).map((m) => m.id)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${target ? 'Disabled' : 'Unknown'} agent "${mode}". Enabled: ${enabled.join(', ')}`
    })
  }

  const launch = await resolveMainAgentLaunch(db, taskId, io.getTask)
  if (launch.kind === 'chat') await getChatDeps().ops.kill(launch.tabId)
  else await getPtyDeps().ops.ptyKill(launch.sessionId)

  // A mode switch starts the MAIN tab fresh — in every mode, so switching back
  // does not resume the abandoned session either. Only the main tab: the task's
  // other agent tabs keep their own sessions. (This used to reset every tab of
  // the task, which is how a secondary "deploy" tab lost its session.)
  // Chat modes are left to the update below exactly as before: a chat tab's
  // conversation is owned per tab by the chat runtime (`chat_ownership`).
  await resetConversation(db, {
    taskId,
    scope: { tabId: taskId },
    exceptChat: true
  })

  const updated = await io.update({ id: taskId, agentId: mode })
  if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
  return updated
}

async function detectChildRepos(taskId: string, projectPath: string): Promise<DetectedRepo[]> {
  if (!deps) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'repo discovery is not wired — @slayzone/api wires it when it composes the router'
    })
  }
  return deps.detectChildRepos({ taskId }, projectPath)
}
