/**
 * Shared core of the `/api/chat/*` routes (and the chat side of `/api/agent/*`):
 * which chat tab a request addresses, the folder-bearing opts the lifecycle ops
 * take, where the turn stands (live status + the reduced saved history), and the
 * error → HTTP mapping. The routes stay thin; `slay chat` / `slay agent` call them.
 *
 * Addressing: `:id` is a task id or prefix; the tab is the task's main tab unless
 * `?tab=` / `body.tab` names another chat tab of the same task (a thread, a split).
 */
import type { Request, Response } from 'express'
import { TRPCError } from '@trpc/server'
import {
  chatCapabilitiesForMode,
  isChatSupported,
  type AgentEvent,
  type ChatTurnStatus,
  type PermissionRequestEvent
} from '@slayzone/terminal-contracts'
import { initialState, reducer, type ChatTimelineState } from '@slayzone/terminal/reducer'
import {
  ChatPromptAnswerError,
  describeChatPrompt,
  type ChatPromptView
} from '@slayzone/task-terminals/prompt-answers'
import type { ChatAccess, RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

export interface ChatTarget {
  taskId: string
  tabId: string
  /** `${taskId}:${tabId}` — the state bus key. */
  sessionId: string
  mode: string
  isMain: boolean
}

export type ChatCreateOpts = Parameters<ReturnType<ChatAccess['deps']>['ops']['interrupt']>[0]

/** A request refused with a status the handler answers as is. */
export class ChatRouteError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ChatRouteError'
  }
}

export function requireChat(deps: RestApiDeps, res: Response): ChatAccess | null {
  if (!deps.chat) {
    res.status(501).json({ ok: false, error: NOT_AVAILABLE_STANDALONE })
    return null
  }
  return deps.chat
}

/** The tab named by `?tab=` (GET, DELETE) or `body.tab` (POST), if any — where the owner gate checks it. */
export function tabParam(req: Request): string | undefined {
  const raw =
    req.method === 'GET' || req.method === 'DELETE'
      ? req.query.tab
      : (req.body as { tab?: unknown } | undefined)?.tab
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** Resolve the task (prefix) and its chat tab; throws `ChatRouteError` when it has none. */
export async function resolveChatTarget(
  deps: RestApiDeps,
  chat: ChatAccess,
  taskRef: string,
  tab: string | undefined
): Promise<ChatTarget> {
  const task = await resolveByIdPrefix<{ id: string }>(deps.db, 'tasks', taskRef, 'Task', 'id')
  if (isResolveFailure(task)) throw new ChatRouteError(task.status, task.error)
  const taskId = task.row.id
  if (tab && tab !== taskId) {
    const row = await deps.db.get<{ task_id: string; mode: string }>(
      'SELECT task_id, mode FROM terminal_tabs WHERE id = ?',
      [tab]
    )
    // A thread tab has no terminal_tabs row; its live session names its task.
    const mode = row
      ? row.task_id === taskId
        ? row.mode
        : null
      : await Promise.resolve(chat.deps().ops.getInfo(tab)).then((info) =>
          info?.taskId === taskId ? info.mode : null
        )
    if (!mode) throw new ChatRouteError(404, `Tab not found in task ${taskId.slice(0, 8)}: ${tab}`)
    if (!isChatSupported(mode))
      throw new ChatRouteError(
        409,
        `Tab ${tab} runs ${mode} in a terminal, not chat — use \`slay pty\``
      )
    return { taskId, tabId: tab, sessionId: `${taskId}:${tab}`, mode, isMain: false }
  }
  const launch = await chat.launch(taskId)
  if (launch.kind !== 'chat')
    throw new ChatRouteError(
      409,
      `Task ${taskId.slice(0, 8)} runs ${launch.mode} in a terminal, not chat — use \`slay agent\` or \`slay pty\``
    )
  return {
    taskId,
    tabId: launch.tabId,
    sessionId: launch.sessionId,
    mode: launch.mode,
    isMain: true
  }
}

/** The opts lifecycle ops take: the live session's folder, else the task's (as a start would). */
export async function chatOpts(chat: ChatAccess, target: ChatTarget): Promise<ChatCreateOpts> {
  const info = await chat.deps().ops.getInfo(target.tabId, target.mode)
  const base = { tabId: target.tabId, taskId: target.taskId, mode: target.mode }
  if (info) return { ...base, cwd: info.cwd }
  const launch = await chat.launch(target.taskId)
  return {
    ...base,
    cwd: await launch.resolveCwd(),
    providerFlagsOverride: target.isMain ? launch.providerFlagsOverride : null
  }
}

/** Where the turn stands; null when the tab has no session on its computer. */
export async function turnStatus(
  chat: ChatAccess,
  target: ChatTarget
): Promise<ChatTurnStatus | null> {
  try {
    return (await chat.deps().ops.getTurnStatus(target.tabId)) ?? null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/Unknown chat tab/.test(message)) return null
    throw new ChatRouteError(
      502,
      `Could not read the chat's turn status (${message}). The computer running it may need an update.`
    )
  }
}

/** The saved history, reduced the way the chat panel reduces it. */
export async function reducedHistory(
  chat: ChatAccess,
  target: ChatTarget
): Promise<{
  state: ChatTimelineState
  lastSeq: number
  events: Array<{ seq: number; event: AgentEvent }>
}> {
  let events: Array<{ seq: number; event: AgentEvent; at?: number }> = []
  try {
    events = (await chat.deps().ops.getBufferSince(target.tabId, -1)) as typeof events
  } catch (err) {
    if (!/Unknown chat tab/.test(err instanceof Error ? err.message : String(err))) throw err
  }
  const state = reducer(
    initialState({ agentStartedTurns: chatCapabilitiesForMode(target.mode).agentStartedTurns }),
    {
      type: 'events',
      events: events.map((e) => e.event),
      at: events.map((e) => e.at),
      seq: events.map((e) => e.seq)
    }
  )
  return { state, lastSeq: events.at(-1)?.seq ?? -1, events }
}

/** The prompts the agent is blocked on right now, oldest first. */
export function pendingPrompts(
  state: ChatTimelineState,
  status: ChatTurnStatus | null
): PermissionRequestEvent[] {
  if (!status) return []
  const byId = new Map(state.prompts.map((p) => [p.requestId, p.request]))
  return status.pendingRequestIds.flatMap((id) => {
    const req = byId.get(id)
    return req ? [req] : []
  })
}

/** What a card would need: the account's auto mode, the session's folder. */
export async function promptContext(
  chat: ChatAccess,
  target: ChatTarget
): Promise<{ autoModeAvailable: boolean; cwd: string; agent: string }> {
  const deps = chat.deps()
  const [info, auto] = await Promise.all([
    Promise.resolve(deps.ops.getInfo(target.tabId)).catch(() => null),
    Promise.resolve(
      deps.catalog
        ? deps.catalog.getAutoEligibility({ taskId: target.taskId, tabId: target.tabId })
        : deps.ops.getAutoEligibility()
    ).catch(() => null)
  ])
  return {
    autoModeAvailable: target.mode === 'claude-chat' && auto?.optedIn === true,
    cwd: info?.cwd ?? '',
    agent: target.mode === 'codex-chat' ? 'Codex' : 'Claude'
  }
}

export function describePrompts(
  prompts: PermissionRequestEvent[],
  ctx: Awaited<ReturnType<typeof promptContext>>
): ChatPromptView[] {
  return prompts.map((p) => describeChatPrompt(p, ctx))
}

/** Answer a failure with its status: route refusals, unknown tasks, bad answers, then 500. */
export function sendChatError(res: Response, err: unknown): void {
  if (res.headersSent) return
  if (err instanceof ChatRouteError) {
    res.status(err.status).json({ ok: false, error: err.message })
    return
  }
  if (err instanceof ChatPromptAnswerError) {
    res.status(400).json({ ok: false, error: err.message })
    return
  }
  if (err instanceof TRPCError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'PRECONDITION_FAILED' || err.code === 'CONFLICT'
          ? 409
          : err.code === 'BAD_REQUEST'
            ? 400
            : 500
    res.status(status).json({ ok: false, error: err.message })
    return
  }
  res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
}

/** Wrap a handler: resolve chat + target, answer errors uniformly. */
export function chatHandler(
  deps: RestApiDeps,
  handle: (ctx: {
    chat: ChatAccess
    target: ChatTarget
    req: Request
    res: Response
  }) => Promise<void>
) {
  return async (req: Request, res: Response): Promise<void> => {
    const chat = requireChat(deps, res)
    if (!chat) return
    try {
      const target = await resolveChatTarget(deps, chat, String(req.params.id), tabParam(req))
      await handle({ chat, target, req, res })
    } catch (err) {
      sendChatError(res, err)
    }
  }
}
