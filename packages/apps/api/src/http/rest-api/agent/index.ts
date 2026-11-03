/**
 * `/api/agent/:id/*` — drive a task's MAIN agent whatever it runs in (`slay agent`).
 * The task's mode picks the side: a chat tab goes through the chat core
 * (`../chat/_chat.ts`), a terminal through the pty runtime — the same calls
 * `slay chat` and `slay pty` make, so an orchestrator never has to know which.
 *
 *   GET  status     { kind, mode, state, … }
 *   POST send       { text, steer? } → chat: queued like the composer; pty: submitted
 *   GET  wait       ?timeout= → { outcome: idle | prompt | dead | error | timeout }
 *   GET  read       ?last=&verbose= → text: chat transcript / terminal buffer
 *   POST interrupt  chat: stop the turn; pty: Ctrl-C
 */
import type { Express, Request, Response } from 'express'
import { formatChatTranscript, transcriptRows } from '@slayzone/terminal/chat-transcript'
import type { ChatAccess, PtyAccess, RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'
import {
  chatOpts,
  ChatRouteError,
  reducedHistory,
  sendChatError,
  turnStatus,
  type ChatTarget
} from '../chat/_chat'
import { waitForChat } from '../chat/_wait'
import { sendChatMessage } from '../chat/act'
import { waitForPtyState } from '../pty/_wait'
import { startMainPty } from '../pty/_start-main'

const AUTO_START_TIMEOUT_MS = 5_000

type Agent =
  | { kind: 'chat'; chat: ChatAccess; target: ChatTarget }
  | { kind: 'pty'; pty: PtyAccess; taskId: string; sessionId: string; mode: string }

const intParam = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

async function resolveAgent(deps: RestApiDeps, taskRef: string): Promise<Agent> {
  if (!deps.chat) throw new ChatRouteError(501, NOT_AVAILABLE_STANDALONE)
  const task = await resolveByIdPrefix<{ id: string }>(deps.db, 'tasks', taskRef, 'Task', 'id')
  if (isResolveFailure(task)) throw new ChatRouteError(task.status, task.error)
  const launch = await deps.chat.launch(task.row.id)
  if (launch.kind === 'chat')
    return {
      kind: 'chat',
      chat: deps.chat,
      target: {
        taskId: launch.taskId,
        tabId: launch.tabId,
        sessionId: launch.sessionId,
        mode: launch.mode,
        isMain: true
      }
    }
  if (!deps.pty) throw new ChatRouteError(501, NOT_AVAILABLE_STANDALONE)
  return {
    kind: 'pty',
    pty: deps.pty,
    taskId: launch.taskId,
    sessionId: launch.sessionId,
    mode: launch.mode
  }
}

function agentHandler(
  deps: RestApiDeps,
  handle: (agent: Agent, req: Request, res: Response) => Promise<void>
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handle(await resolveAgent(deps, String(req.params.id)), req, res)
    } catch (err) {
      sendChatError(res, err)
    }
  }
}

/** Start a cold main terminal the way `slay pty submit` does. */
async function ensurePty(
  deps: RestApiDeps,
  agent: Extract<Agent, { kind: 'pty' }>
): Promise<boolean> {
  if (agent.pty.hasLivePty(agent.sessionId)) return false
  const r = await startMainPty(deps, agent.pty, agent.taskId, { timeoutMs: AUTO_START_TIMEOUT_MS })
  if (r === 'no-window') throw new ChatRouteError(503, 'No window available to start the terminal')
  if (r === 'timeout') throw new ChatRouteError(504, 'Terminal start timed out')
  if (r === 'error' || r === 'no-task')
    throw new ChatRouteError(500, 'The terminal could not be started')
  return true
}

export function registerAgentRoutes(app: Express, deps: RestApiDeps): void {
  app.get(
    '/api/agent/:id/status',
    agentHandler(deps, async (agent, _req, res) => {
      if (agent.kind === 'chat') {
        const status = await turnStatus(agent.chat, agent.target)
        res.json({
          ok: true,
          data: {
            kind: 'chat',
            taskId: agent.target.taskId,
            mode: agent.target.mode,
            state: status?.state ?? 'not-spawned',
            turnOpen: status?.turnOpen ?? false,
            pendingPrompts: status?.pendingRequestIds.length ?? 0
          }
        })
        return
      }
      const live = agent.pty.hasLivePty(agent.sessionId)
      res.json({
        ok: true,
        data: {
          kind: 'pty',
          taskId: agent.taskId,
          mode: agent.mode,
          sessionId: agent.sessionId,
          state: live ? (agent.pty.getState(agent.sessionId) ?? 'running') : 'not-spawned',
          turnOpen: live && agent.pty.getState(agent.sessionId) === 'running',
          pendingPrompts: 0
        }
      })
    })
  )

  app.post(
    '/api/agent/:id/send',
    agentHandler(deps, async (agent, req, res) => {
      const body = (req.body ?? {}) as { text?: unknown; steer?: unknown; messageId?: unknown }
      if (typeof body.text !== 'string' || body.text.trim() === '')
        throw new ChatRouteError(400, 'text must be a non-empty string')
      if (agent.kind === 'chat') {
        const sent = await sendChatMessage(agent.chat, agent.target, {
          text: body.text,
          messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
          steer: body.steer === true
        })
        res.json({ ok: true, data: { kind: 'chat', taskId: agent.target.taskId, ...sent } })
        return
      }
      const started = await ensurePty(deps, agent)
      if (!agent.pty.submitPty(agent.sessionId, body.text))
        throw new ChatRouteError(404, 'PTY session not found')
      res.json({
        ok: true,
        data: { kind: 'pty', taskId: agent.taskId, sessionId: agent.sessionId, started }
      })
    })
  )

  // Always 200 with an outcome, as `/api/chat/:id/wait`.
  app.get(
    '/api/agent/:id/wait',
    agentHandler(deps, async (agent, req, res) => {
      const timeoutMs = Math.min(Math.max(intParam(req.query.timeout) ?? 60_000, 1000), 3_600_000)
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      if (agent.kind === 'chat') {
        const result = await waitForChat(agent.chat, agent.target, {
          until: 'idle',
          timeoutMs,
          signal: abort.signal
        })
        if (!abort.signal.aborted) res.json({ ok: true, data: { kind: 'chat', ...result } })
        return
      }
      if (!agent.pty.hasLivePty(agent.sessionId)) {
        res.json({ ok: true, data: { kind: 'pty', outcome: 'dead', state: 'not-spawned' } })
        return
      }
      const result = await waitForPtyState(
        agent.pty,
        agent.sessionId,
        'idle',
        timeoutMs,
        abort.signal
      )
      if (abort.signal.aborted) return
      res.json({
        ok: true,
        data: {
          kind: 'pty',
          outcome: result.outcome === 'reached' ? 'idle' : result.outcome,
          state: result.state
        }
      })
    })
  )

  app.get(
    '/api/agent/:id/read',
    agentHandler(deps, async (agent, req, res) => {
      const last = intParam(req.query.last)
      if (agent.kind === 'chat') {
        const { state } = await reducedHistory(agent.chat, agent.target)
        const rows = transcriptRows(state, {
          last,
          verbose: req.query.verbose === '1' || req.query.verbose === 'true'
        })
        res.type('text/plain').send(formatChatTranscript(rows))
        return
      }
      // The computer holds the only scrollback: a read is a round trip.
      const buffer = await agent.pty.getBuffer(agent.sessionId)
      if (buffer === null) throw new ChatRouteError(404, 'The terminal has no session')
      const lines = buffer.split('\n')
      res
        .type('text/plain')
        .send(last !== undefined && last >= 0 ? lines.slice(-last).join('\n') : buffer)
    })
  )

  app.post(
    '/api/agent/:id/interrupt',
    agentHandler(deps, async (agent, _req, res) => {
      if (agent.kind === 'chat') {
        const status = await turnStatus(agent.chat, agent.target)
        if (status?.turnOpen)
          await agent.chat.deps().ops.interrupt(await chatOpts(agent.chat, agent.target))
        res.json({ ok: true, data: { kind: 'chat', interrupted: status?.turnOpen === true } })
        return
      }
      const ok =
        agent.pty.hasLivePty(agent.sessionId) && agent.pty.writePty(agent.sessionId, '\x03')
      res.json({ ok: true, data: { kind: 'pty', interrupted: ok } })
    })
  )
}
