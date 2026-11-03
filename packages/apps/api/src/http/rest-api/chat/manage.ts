import type { Express } from 'express'
import { updateTaskOp } from '@slayzone/task/server'
import { isChatSupported, terminalModeForChat } from '@slayzone/terminal-contracts'
import type { RestApiDeps } from '../types'
import { NOOP_TASK_BUS } from '../types'
import { chatHandler, chatOpts, ChatRouteError } from './_chat'

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** Manage routes: the queue, session settings, conversation shape, chat → terminal hand-off. */
export function registerChatManageRoutes(app: Express, deps: RestApiDeps): void {
  // ── queue ──
  app.get(
    '/api/chat/:id/queue',
    chatHandler(deps, async ({ chat, target, res }) => {
      const items = await chat.deps().queueOps.list(target.tabId)
      res.json({
        ok: true,
        data: items.map((m) => ({
          id: m.id,
          text: m.send,
          position: m.position,
          createdAt: m.createdAt,
          ...('steering' in m && m.steering ? { steering: true } : {})
        }))
      })
    })
  )

  app.delete(
    '/api/chat/:id/queue',
    chatHandler(deps, async ({ chat, target, res }) => {
      const removed = await chat.deps().queueOps.clear(target.tabId)
      res.json({ ok: true, data: { removed } })
    })
  )

  /** A queued item of THIS tab (by id or prefix); refuses another tab's item. */
  const queuedItem = async (
    chat: Parameters<Parameters<typeof chatHandler>[1]>[0]['chat'],
    tabId: string,
    ref: string
  ) => {
    const items = await chat.deps().queueOps.list(tabId)
    const matches = items.filter((m) => m.id.startsWith(ref))
    if (matches.length === 0) throw new ChatRouteError(404, `No queued message ${ref}`)
    if (matches.length > 1)
      throw new ChatRouteError(
        400,
        `Ambiguous queued message id "${ref}". Matches: ${matches.map((m) => m.id).join(', ')}`
      )
    return matches[0]
  }

  app.delete(
    '/api/chat/:id/queue/:itemId',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const item = await queuedItem(chat, target.tabId, String(req.params.itemId))
      const removed = await chat.deps().queueOps.remove(item.id)
      res.json({ ok: true, data: { id: item.id, removed } })
    })
  )

  app.post(
    '/api/chat/:id/queue/:itemId/steer',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const item = await queuedItem(chat, target.tabId, String(req.params.itemId))
      const result = await chat.deps().queueOps.steer(item.id)
      if (!result.ok) throw new ChatRouteError(409, result.reason)
      res.json({ ok: true, data: { id: item.id, steered: true } })
    })
  )

  // ── settings: POST /api/chat/:id/settings { permissionMode?, model?, effort? } ──
  app.post(
    '/api/chat/:id/settings',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const body = (req.body ?? {}) as {
        permissionMode?: unknown
        model?: unknown
        effort?: unknown
      }
      for (const key of ['permissionMode', 'model', 'effort'] as const) {
        if (body[key] !== undefined && !isStr(body[key]))
          throw new ChatRouteError(400, `${key} must be a non-empty string`)
      }
      if (
        body.permissionMode === undefined &&
        body.model === undefined &&
        body.effort === undefined
      )
        throw new ChatRouteError(400, 'Set at least one of permissionMode, model, effort')
      const ops = chat.deps().ops
      const opts = await chatOpts(chat, target)
      if (isStr(body.permissionMode)) await ops.setMode({ ...opts, chatMode: body.permissionMode })
      if (isStr(body.model)) await ops.setModel({ ...opts, chatModel: body.model })
      if (isStr(body.effort)) await ops.setEffort({ ...opts, chatEffort: body.effort })
      const [permissionMode, model, effort] = await Promise.all([
        ops.getMode(target.taskId, target.mode),
        ops.getModel(target.taskId, target.mode),
        ops.getEffort(target.taskId, target.mode)
      ])
      res.json({ ok: true, data: { permissionMode, model, effort } })
    })
  )

  // ── conversation shape ──
  // POST /api/chat/:id/fork { messageId } — a new conversation up to that message's turn.
  app.post(
    '/api/chat/:id/fork',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const messageId = (req.body ?? {}).messageId
      if (!isStr(messageId)) throw new ChatRouteError(400, 'messageId is required')
      const result = await chat.deps().ops.fork({ ...(await chatOpts(chat, target)), messageId })
      res.json({ ok: true, data: result })
    })
  )

  // POST /api/chat/:id/rewind { messageId, scope: before|after, conversation?, files?, preview? }
  app.post(
    '/api/chat/:id/rewind',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const body = (req.body ?? {}) as {
        messageId?: unknown
        scope?: unknown
        conversation?: unknown
        files?: unknown
        preview?: unknown
      }
      if (!isStr(body.messageId)) throw new ChatRouteError(400, 'messageId is required')
      const rawScope = body.scope ?? 'after'
      if (rawScope !== 'before' && rawScope !== 'after')
        throw new ChatRouteError(400, 'scope must be before or after')
      const scope: 'before' | 'after' = rawScope
      const opts = { ...(await chatOpts(chat, target)), messageId: body.messageId, scope }
      const ops = chat.deps().ops
      if (body.preview === true) {
        res.json({ ok: true, data: await ops.rewindPreview(opts) })
        return
      }
      const conversation = body.conversation !== false
      const files = body.files === true
      if (!conversation && !files)
        throw new ChatRouteError(400, 'Rewind the conversation, the files, or both')
      res.json({ ok: true, data: await ops.rewind({ ...opts, conversation, files }) })
    })
  )

  // POST /api/chat/:id/handoff — move the main chat's conversation to its terminal
  // partner (claude-chat → claude-code): the chat stops, the task switches mode, and
  // the terminal agent starts resuming it — what the panel's "Continue in terminal" does.
  app.post(
    '/api/chat/:id/handoff',
    chatHandler(deps, async ({ chat, target, res }) => {
      if (!target.isMain) throw new ChatRouteError(409, 'Only the main chat tab can hand off')
      const terminalMode = isChatSupported(target.mode) ? terminalModeForChat(target.mode) : null
      if (!terminalMode)
        throw new ChatRouteError(409, `${target.mode} has no terminal partner to hand off to`)
      const { conversationId } = await chat
        .deps()
        .ops.continueInTerminal(await chatOpts(chat, target))
      const updated = await updateTaskOp(
        deps.db,
        { id: target.taskId, terminalMode },
        { ipcMain: deps.taskBus ?? NOOP_TASK_BUS, onMutation: deps.notifyRenderer }
      )
      if (!updated) throw new ChatRouteError(404, `Task not found: ${target.taskId}`)
      const started = await chat.startMain(target.taskId)
      res.json({
        ok: true,
        data: { conversationId, mode: terminalMode, sessionId: started.sessionId }
      })
    })
  )
}
