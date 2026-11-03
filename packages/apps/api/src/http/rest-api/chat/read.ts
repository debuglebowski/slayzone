import type { Express } from 'express'
import { formatChatTranscript, transcriptRows } from '@slayzone/terminal/chat-transcript'
import type { RestApiDeps } from '../types'
import {
  chatHandler,
  describePrompts,
  pendingPrompts,
  promptContext,
  reducedHistory,
  turnStatus
} from './_chat'
import { waitForChat, type ChatWaitUntil } from './_wait'

const intParam = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

/** Read routes: where the turn stands, what it is blocked on, what was said, and waiting. */
export function registerChatReadRoutes(app: Express, deps: RestApiDeps): void {
  // GET /api/chat/:id/status — state, open turn, pending prompts, queue, session settings.
  app.get(
    '/api/chat/:id/status',
    chatHandler(deps, async ({ chat, target, res }) => {
      const ops = chat.deps()
      const [status, info, queued, availability] = await Promise.all([
        turnStatus(chat, target),
        Promise.resolve(ops.ops.getInfo(target.tabId)).catch(() => null),
        Promise.resolve(ops.queueOps.list(target.tabId)).catch(() => []),
        ops.availability ? ops.availability(target.tabId).catch(() => null) : Promise.resolve(null)
      ])
      res.json({
        ok: true,
        data: {
          taskId: target.taskId,
          tabId: target.tabId,
          mode: target.mode,
          state: status?.state ?? 'not-spawned',
          turnOpen: status?.turnOpen ?? false,
          pendingPrompts: status?.pendingRequestIds.length ?? 0,
          outboxInFlight: status?.outboxInFlight ?? 0,
          queued: queued.length,
          availability: availability?.state ?? null,
          conversationId: info?.sessionId ?? null,
          cwd: info?.cwd ?? null,
          permissionMode: info?.chatMode ?? null,
          model: info?.chatModel ?? null,
          effort: info?.chatEffort ?? null
        }
      })
    })
  )

  // GET /api/chat/:id/prompts — the prompts the agent waits on, with their rows/questions.
  app.get(
    '/api/chat/:id/prompts',
    chatHandler(deps, async ({ chat, target, res }) => {
      const [status, history, ctx] = await Promise.all([
        turnStatus(chat, target),
        reducedHistory(chat, target),
        promptContext(chat, target)
      ])
      res.json({ ok: true, data: describePrompts(pendingPrompts(history.state, status), ctx) })
    })
  )

  // GET /api/chat/:id/transcript?since=&last=&verbose=1&format=text|json
  app.get(
    '/api/chat/:id/transcript',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const { state, lastSeq } = await reducedHistory(chat, target)
      const rows = transcriptRows(state, {
        since: intParam(req.query.since),
        last: intParam(req.query.last),
        verbose: req.query.verbose === '1' || req.query.verbose === 'true'
      })
      if (req.query.format === 'json') {
        res.json({
          ok: true,
          data: { rows, lastRow: state.timeline.length - 1, lastSeq }
        })
        return
      }
      res.type('text/plain').send(formatChatTranscript(rows))
    })
  )

  // GET /api/chat/:id/wait?until=idle|prompt|answered&message=<id>&timeout=<ms>
  // Always 200 with an `outcome` (idle | prompt | answered | dead | error | timeout).
  app.get(
    '/api/chat/:id/wait',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const until = (req.query.until as string) || 'idle'
      if (!['idle', 'prompt', 'answered'].includes(until)) {
        res.status(400).json({ ok: false, error: 'until must be idle, prompt or answered' })
        return
      }
      const messageId = typeof req.query.message === 'string' ? req.query.message : undefined
      if (until === 'answered' && !messageId) {
        res.status(400).json({ ok: false, error: 'until=answered needs message=<id>' })
        return
      }
      const timeoutMs = Math.min(Math.max(intParam(req.query.timeout) ?? 60_000, 1000), 3_600_000)
      const abort = new AbortController()
      // The response closing first = the caller went away.
      res.on('close', () => abort.abort())
      const result = await waitForChat(chat, target, {
        until: until as ChatWaitUntil,
        messageId,
        timeoutMs,
        signal: abort.signal
      })
      if (abort.signal.aborted) return
      res.json({ ok: true, data: result })
    })
  )
}
