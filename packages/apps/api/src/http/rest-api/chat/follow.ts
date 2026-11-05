import type { Express } from 'express'
import type {
  AgentEvent,
  ChatSavedSummary,
  PermissionRequestEvent
} from '@slayzone/terminal-contracts'
import { reducer } from '@slayzone/terminal/reducer'
import { transcriptRows } from '@slayzone/terminal/chat-transcript'
import { describeChatPrompt } from '@slayzone/task-terminals/prompt-answers'
import type { RestApiDeps } from '../types'
import { chatHandler, promptContext, reducedHistory } from './_chat'

/** How long a saved event's full copy may lag its summary before it is read back. */
const SAVED_READ_BACK_MS = 250

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

      const deps = chat.deps()
      const events = deps.events
      // Computers send the hub full events only for watched tabs (docs/direct-link.md):
      // this stream is a watcher. Every saved event's summary arrives regardless, so a
      // seq the full stream did not bring (saved before the computer applied the
      // watch) is read back from the saved history. Until it is, full events after it
      // are held: shown in seq order, and `lastSeq` never jumps past the gap.
      const unwatch = deps.watchEvents?.([target.tabId])
      /** Seqs seen only as a summary so far. */
      const summaryOnly = new Set<number>()
      /** Full events past a summary-only seq, waiting for it. */
      const held = new Map<number, { event: AgentEvent; at?: number }>()
      let resync: ReturnType<typeof setTimeout> | null = null
      let closed = false

      const show = (event: AgentEvent, seq: number, at?: number) => {
        if (seq <= lastSeq) return
        lastSeq = seq
        summaryOnly.delete(seq)
        state = reducer(state, { type: 'event', event, at, seq })
        flushRows()
        if (event.kind === 'permission-request' && !seenPrompts.has(event.requestId)) {
          seenPrompts.add(event.requestId)
          send('prompt', describeChatPrompt(event as PermissionRequestEvent, ctx))
        }
      }
      const gapBefore = (seq: number) => [...summaryOnly].some((s) => s > lastSeq && s < seq)
      const drainHeld = () => {
        for (const seq of [...held.keys()].sort((x, y) => x - y)) {
          if (gapBefore(seq)) return
          const e = held.get(seq)!
          held.delete(seq)
          show(e.event, seq, e.at)
        }
      }
      const scheduleReadBack = () => {
        // A short grace: on a watched tab the full event is usually already on its way.
        resync ??= setTimeout(() => {
          resync = null
          void readBack().catch(() => scheduleReadBack())
        }, SAVED_READ_BACK_MS)
      }
      const readBack = async () => {
        if (closed || (summaryOnly.size === 0 && held.size === 0)) return
        const missed = (await deps.ops.getBufferSince(target.tabId, lastSeq)) as Array<{
          seq: number
          event: AgentEvent
          at?: number
        }>
        if (closed) return
        // The saved history is complete and in order: no gap inside it.
        for (const e of missed) {
          held.delete(e.seq)
          show(e.event, e.seq, e.at)
        }
        for (const seq of [...summaryOnly]) if (seq <= lastSeq) summaryOnly.delete(seq)
        drainHeld()
        if (summaryOnly.size > 0 || held.size > 0) scheduleReadBack()
      }
      const apply = (event: AgentEvent, seq: number, at?: number) => {
        if (seq <= lastSeq) return
        if (gapBefore(seq)) {
          held.set(seq, { event, at })
          scheduleReadBack()
          return
        }
        show(event, seq, at)
        drainHeld()
      }
      const onEvent = (
        tabId: string,
        event: AgentEvent,
        seq: number,
        live?: number,
        at?: number
      ) => {
        // Live-only events (stream deltas) are never saved; the saved block follows.
        if (tabId !== target.tabId || live !== undefined) return
        apply(event, seq, at)
      }
      const onSaved = (tabId: string, saved: ChatSavedSummary) => {
        if (tabId !== target.tabId || saved.seq <= lastSeq) return
        summaryOnly.add(saved.seq)
        scheduleReadBack()
      }
      const onExit = (tabId: string) => {
        if (tabId === target.tabId) send('exit', {})
      }
      events.on('event', onEvent)
      events.on('saved', onSaved)
      events.on('exit', onExit)
      const offState = chat.onStateChange((sessionId, s) => {
        if (sessionId === target.sessionId) send('state', { state: s })
      })
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
      res.on('close', () => {
        closed = true
        unwatch?.()
        if (resync) clearTimeout(resync)
        events.off('event', onEvent)
        events.off('saved', onSaved)
        events.off('exit', onExit)
        offState()
        clearInterval(keepAlive)
      })
    })
  )
}
