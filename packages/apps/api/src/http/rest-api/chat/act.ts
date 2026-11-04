import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import { decideChatPrompt, type ChatPromptAnswer } from '@slayzone/task-terminals/prompt-answers'
import type { ChatAccess, RestApiDeps } from '../types'
import {
  chatHandler,
  chatOpts,
  ChatRouteError,
  pendingPrompts,
  promptContext,
  reducedHistory,
  turnStatus,
  type ChatTarget
} from './_chat'

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** Make sure the tab has a running agent: the main one starts as `task.startMainAgent` does. */
export async function ensureStarted(chat: ChatAccess, target: ChatTarget): Promise<boolean> {
  const status = await turnStatus(chat, target)
  if (status && status.state !== 'dead' && status.state !== 'not-spawned') return false
  if (target.isMain) await chat.startMain(target.taskId)
  else await chat.deps().ops.start({ ...(await chatOpts(chat, target)), reason: 'user' })
  return true
}

/** Queue a message the way the composer does (it waits for the turn), optionally steering it in. */
export async function sendChatMessage(
  chat: ChatAccess,
  target: ChatTarget,
  input: { text: string; messageId?: string; steer?: boolean }
): Promise<{ messageId: string; started: boolean; steered: boolean | null; steerError?: string }> {
  const started = await ensureStarted(chat, target)
  const queue = chat.deps().queueOps
  const item = await queue.push(target.tabId, input.text, input.text, {
    id: input.messageId ?? randomUUID(),
    content: [{ type: 'text', text: input.text }],
    expectedMode: target.mode
  })
  if (!input.steer) return { messageId: item.id, started, steered: null }
  const steer = await queue.steer(item.id)
  return steer.ok
    ? { messageId: item.id, started, steered: true }
    : { messageId: item.id, started, steered: false, steerError: steer.reason }
}

/** Act routes: send, answer prompts, stop/restart/kill/reset. */
export function registerChatActRoutes(app: Express, deps: RestApiDeps): void {
  // POST /api/chat/:id/send { text, messageId?, steer?, tab? }
  app.post(
    '/api/chat/:id/send',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const body = (req.body ?? {}) as { text?: unknown; messageId?: unknown; steer?: unknown }
      if (!isStr(body.text) || body.text.trim() === '') {
        res.status(400).json({ ok: false, error: 'text must be a non-empty string' })
        return
      }
      if (body.messageId !== undefined && !isStr(body.messageId)) {
        res.status(400).json({ ok: false, error: 'messageId must be a string' })
        return
      }
      const data = await sendChatMessage(chat, target, {
        text: body.text,
        messageId: body.messageId as string | undefined,
        steer: body.steer === true
      })
      res.json({ ok: true, data: { taskId: target.taskId, tabId: target.tabId, ...data } })
    })
  )

  // POST /api/chat/:id/prompts/:requestId { option?, message?, answers?, tab? }
  // `:requestId` may be a prefix of a pending prompt's id.
  app.post(
    '/api/chat/:id/prompts/:requestId',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const body = (req.body ?? {}) as { option?: unknown; message?: unknown; answers?: unknown }
      if (body.option !== undefined && !isStr(body.option))
        throw new ChatRouteError(400, 'option must be a string')
      if (body.message !== undefined && typeof body.message !== 'string')
        throw new ChatRouteError(400, 'message must be a string')
      const answers = body.answers
      if (
        answers !== undefined &&
        (typeof answers !== 'object' ||
          answers === null ||
          Array.isArray(answers) ||
          !Object.values(answers).every(
            (v) =>
              typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))
          ))
      )
        throw new ChatRouteError(
          400,
          'answers must map question keys to strings (or string arrays)'
        )
      const [status, history, ctx] = await Promise.all([
        turnStatus(chat, target),
        reducedHistory(chat, target),
        promptContext(chat, target)
      ])
      const pending = pendingPrompts(history.state, status)
      const ref = String(req.params.requestId)
      const matches = pending.filter((p) => p.requestId.startsWith(ref))
      if (matches.length === 0)
        throw new ChatRouteError(
          409,
          pending.length
            ? `No pending prompt ${ref}. Pending: ${pending.map((p) => p.requestId).join(', ')}`
            : `No pending prompt ${ref}: the agent is not waiting for an answer`
        )
      if (matches.length > 1)
        throw new ChatRouteError(
          400,
          `Ambiguous prompt id "${ref}". Matches: ${matches.map((p) => p.requestId).join(', ')}`
        )
      const request = matches[0]
      const answer: ChatPromptAnswer = {
        ...(isStr(body.option) ? { optionId: body.option } : {}),
        ...(typeof body.message === 'string' ? { message: body.message } : {}),
        ...(answers ? { answers: answers as ChatPromptAnswer['answers'] } : {})
      }
      const decided = decideChatPrompt(request, answer, ctx)
      const ok = await chat.deps().ops.respondPermission(target.tabId, {
        requestId: request.requestId,
        optionId: decided.optionId,
        decision: decided.decision
      })
      if (!ok) throw new ChatRouteError(409, `Prompt ${request.requestId} is no longer pending`)
      let followUp: string | null = null
      if (decided.followUpMessage)
        followUp = (await sendChatMessage(chat, target, { text: decided.followUpMessage }))
          .messageId
      res.json({
        ok: true,
        data: {
          requestId: request.requestId,
          optionId: decided.optionId,
          decision: decided.decision,
          followUpMessageId: followUp
        }
      })
    })
  )

  // POST /api/chat/:id/interrupt — stop the running turn; the session and queue stay.
  app.post(
    '/api/chat/:id/interrupt',
    chatHandler(deps, async ({ chat, target, res }) => {
      const status = await turnStatus(chat, target)
      if (!status || !status.turnOpen) {
        res.json({ ok: true, data: { interrupted: false } })
        return
      }
      await chat.deps().ops.interrupt(await chatOpts(chat, target))
      res.json({ ok: true, data: { interrupted: true } })
    })
  )

  // POST /api/chat/:id/stop — the panel's Stop/Esc: clear the queue, stop the turn,
  // and pop the last message back when the agent had not answered it yet.
  app.post(
    '/api/chat/:id/stop',
    chatHandler(deps, async ({ chat, target, res }) => {
      const result = await chat.deps().ops.abortAndPop(await chatOpts(chat, target))
      res.json({
        ok: true,
        data: { popped: result.popped, text: result.popped ? result.text : null }
      })
    })
  )

  // POST /api/chat/:id/restart — replace the process, keep the conversation.
  app.post(
    '/api/chat/:id/restart',
    chatHandler(deps, async ({ chat, target, res }) => {
      const info = await chat.deps().ops.restart(await chatOpts(chat, target))
      res.json({ ok: true, data: { pid: info?.pid ?? null } })
    })
  )

  // POST /api/chat/:id/kill — stop the process (the conversation stays).
  app.post(
    '/api/chat/:id/kill',
    chatHandler(deps, async ({ chat, target, res }) => {
      await chat.deps().ops.kill(target.tabId)
      res.json({ ok: true, data: { killed: true } })
    })
  )

  // POST /api/chat/:id/reset — a fresh conversation in this tab (history and queue cleared).
  app.post(
    '/api/chat/:id/reset',
    chatHandler(deps, async ({ chat, target, res }) => {
      if (!target.isMain && target.tabId !== target.taskId) {
        // `reset` refuses thread tabs itself; this message is the clearer one.
        const row = await deps.db.get<{ id: string }>('SELECT id FROM terminal_tabs WHERE id = ?', [
          target.tabId
        ])
        if (!row) throw new ChatRouteError(409, 'A thread cannot be reset')
      }
      await chat.deps().ops.reset(await chatOpts(chat, target))
      res.json({ ok: true, data: { reset: true } })
    })
  )
}
