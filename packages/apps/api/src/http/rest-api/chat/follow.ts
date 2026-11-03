import type { Express } from 'express'
import type { AgentEvent, PermissionRequestEvent } from '@slayzone/terminal-contracts'
import { reducer } from '@slayzone/terminal/reducer'
import { transcriptRows } from '@slayzone/terminal/chat-transcript'
import { describeChatPrompt } from '@slayzone/task-terminals/prompt-answers'
import type { RestApiDeps } from '../types'
import { chatHandler, promptContext, reducedHistory } from './_chat'

const intParam = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

/**
 * GET /api/chat/:id/follow?since=<row>&verbose=1 — Server-Sent Events:
 *   `event: row`    a transcript row ({row, role, text}) as it lands
 *   `event: prompt` the agent asks (a prompt view, as `GET …/prompts` lists it)
 *   `event: state`  the session's state changed ({state})
 *   `event: exit`   the agent process exited
 * Without `since`, starts after the newest row (only what happens next); with
 * `since=-1`, replays the whole conversation first.
 */
export function registerChatFollowRoute(app: Express, deps: RestApiDeps): void {
  app.get(
    '/api/chat/:id/follow',
    chatHandler(deps, async ({ chat, target, req, res }) => {
      const verbose = req.query.verbose === '1' || req.query.verbose === 'true'
      const history = await reducedHistory(chat, target)
      let state = history.state
      let lastSeq = history.lastSeq
      let lastRow = intParam(req.query.since) ?? state.timeline.length - 1
      const ctx = await promptContext(chat, target)
      const seenPrompts = new Set(state.prompts.map((p) => p.requestId))

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

      const flushRows = () => {
        for (const row of transcriptRows(state, { since: lastRow, verbose })) send('row', row)
        // Rows are emitted once: a row that is still being filled (a tool awaiting
        // its result) is not re-sent.
        lastRow = Math.max(lastRow, state.timeline.length - 1)
      }
      flushRows()

      const events = chat.deps().events
      const onEvent = (
        tabId: string,
        event: AgentEvent,
        seq: number,
        live?: number,
        at?: number
      ) => {
        // Live-only events (stream deltas) are never saved; the saved block follows.
        if (tabId !== target.tabId || live !== undefined || seq <= lastSeq) return
        lastSeq = seq
        state = reducer(state, { type: 'event', event, at, seq })
        flushRows()
        if (event.kind === 'permission-request' && !seenPrompts.has(event.requestId)) {
          seenPrompts.add(event.requestId)
          send('prompt', describeChatPrompt(event as PermissionRequestEvent, ctx))
        }
      }
      const onExit = (tabId: string) => {
        if (tabId === target.tabId) send('exit', {})
      }
      events.on('event', onEvent)
      events.on('exit', onExit)
      const offState = chat.onStateChange((sessionId, s) => {
        if (sessionId === target.sessionId) send('state', { state: s })
      })
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
      res.on('close', () => {
        events.off('event', onEvent)
        events.off('exit', onExit)
        offState()
        clearInterval(keepAlive)
      })
    })
  )
}
