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
import type { Task } from '@slayzone/task-contracts'
import type { DetectedRepo } from '@slayzone/projects-contracts'
import { parseProject } from '@slayzone/projects/server'
import { ensureMainTab } from '@slayzone/task-terminals/server'
import { getChatDeps, getPtyDeps } from '@slayzone/terminal/server'
import {
  isChatSupported,
  spawnConversationIds,
  type TerminalState
} from '@slayzone/terminal-contracts'
import {
  mainTerminalCwd,
  mainTerminalCwdNeedsRepos,
  mainTerminalProps
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

async function startOnce(
  db: SlayzoneDb,
  { taskId, cols, rows }: StartMainAgentInput,
  getTask: (taskId: string) => Promise<Task | null>
): Promise<StartMainAgentResult> {
  const task = await getTask(taskId)
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
  const project = parseProject(
    await db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [task.project_id])
  )
  const pty = getPtyDeps().ops
  const props = mainTerminalProps(task, project, await pty.terminalModesList())
  // The main tab follows the task's mode, as the desktop's `taskTerminals.ensureMain`.
  const tab = await ensureMainTab(db, taskId, props.mode)
  const sessionId = `${taskId}:${tab.id}`
  const kind = isChatSupported(props.mode) ? 'chat' : 'pty'
  const base = { sessionId, tabId: tab.id, mode: props.mode, kind } as const

  // Live already: answer it. Starting again would replace it — a pty create kills
  // the session at this id; a chat hydrate with any other cwd tears the tab down.
  const live = await liveState(kind, sessionId)
  if (live) return { ...base, cwd: null, state: live, started: false }

  const detected = mainTerminalCwdNeedsRepos(task, project)
    ? await detectChildRepos(taskId, project!.path!)
    : []
  const cwd = mainTerminalCwd(task, project, detected)
  if (!cwd) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: "This task has no folder to run in: set the project's folder or the task's base dir"
    })
  }

  if (kind === 'chat') {
    await getChatDeps().ops.start({
      tabId: tab.id,
      taskId,
      mode: props.mode,
      cwd,
      // What the desktop's main chat tab passes (`pane.providerFlags ?? null`).
      providerFlagsOverride: props.providerFlags ?? null,
      // Asked for now: the computer's foreground admission lane.
      reason: 'user'
    })
  } else {
    const ids = spawnConversationIds(
      {
        mode: props.mode,
        supportsSessionId: props.supportsSessionId,
        conversationId: props.conversationId,
        existingConversationId: props.existingConversationId
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
      foreground: true
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

async function detectChildRepos(taskId: string, projectPath: string): Promise<DetectedRepo[]> {
  if (!deps) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'repo discovery is not wired — @slayzone/api wires it when it composes the router'
    })
  }
  return deps.detectChildRepos({ taskId }, projectPath)
}
