import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { randomUUID } from 'node:crypto'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getChatDeps } from './chat-router-deps'

const ops = (): ReturnType<typeof getChatDeps>['ops'] => getChatDeps().ops
const queueOps = (): ReturnType<typeof getChatDeps>['queueOps'] => getChatDeps().queueOps

// Structural input schemas. Value-level validation (which chatMode/effort/model/
// collaboration string is valid for a given provider) lives in the ops layer
// (`isChatEffort`, `isValidChatModeForMode`, … all throw) — the domain owns its
// vocabulary, so the boundary only parses shape + primitive types. The schemas'
// inferred types are assignable to the ops params, so no `as never` casts are
// needed and tsc verifies any drift between schema and ops signature.
const chatCreateOpts = z.object({
  tabId: z.string(),
  taskId: z.string(),
  mode: z.string(),
  cwd: z.string(),
  providerFlagsOverride: z.string().nullish()
})
const toolResultArgs = z.object({
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().optional()
})
const permissionArgs = z.object({
  requestId: z.string(),
  /** Prompt row the user picked (display only; persisted on permission-resolved). */
  optionId: z.string().optional(),
  decision: z.discriminatedUnion('behavior', [
    z.object({
      behavior: z.literal('allow'),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(z.unknown()).optional()
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string(),
      interrupt: z.boolean().optional()
    })
  ])
})

const watchdogTimings = z.object({
  startingBoundMs: z.number().int().positive(),
  runningStallMs: z.number().int().positive(),
  killGraceMs: z.number().int().positive(),
  spawnReplyBoundMs: z.number().int().positive().optional()
})

/** One block of a user message (text today; attachments join in plan item 3.5). */
const userContentBlock = z.object({ type: z.literal('text'), text: z.string() })
/**
 * A user message: the client mints the id (the outbox and the CLI's `uuid` key
 * on it), so a retry of the same id is the same message. Legacy `{text}` (no
 * id) is still accepted and gets a server id.
 */
const sendInput = z.union([
  z.object({
    tabId: z.string(),
    message: z.object({
      id: z.string().min(1).max(200),
      content: z.array(userContentBlock).min(1)
    })
  }),
  z.object({ tabId: z.string(), text: z.string() })
])

/** A past user message + which side of it a rewind keeps (chat A, plan 3.3). */
const rewindOpts = chatCreateOpts.extend({
  messageId: z.string().min(1).max(200),
  scope: z.enum(['before', 'after'])
})

export const chatRouter = router({
  // Test-only (PLAYWRIGHT): shorten the chat watchdog for one spec; `null` restores
  // the defaults. Same gate as pty-router's test procedures.
  testSetWatchdogTimings: publicProcedure
    .input(z.object({ timings: watchdogTimings.nullable() }))
    .mutation(({ input }) => {
      if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
      ops().testSetWatchdogTimings(input.timings)
      return { ok: true }
    }),
  // Core session ops
  supports: publicProcedure
    .input(z.object({ mode: z.string() }))
    .query(({ input }) => ops().supports(input.mode)),
  hydrate: publicProcedure.input(chatCreateOpts).mutation(({ input }) => ops().hydrate(input)),
  start: publicProcedure
    .input(chatCreateOpts.extend({ reason: z.enum(['user', 'restore']).optional() }))
    .mutation(({ input }) => ops().start(input)),
  send: publicProcedure
    .input(sendInput)
    .mutation(({ input }) =>
      ops().send(
        input.tabId,
        'message' in input
          ? input.message
          : { id: randomUUID(), content: [{ type: 'text', text: input.text }] }
      )
    ),
  sendToolResult: publicProcedure
    .input(z.object({ tabId: z.string(), args: toolResultArgs }))
    .mutation(({ input }) => ops().sendToolResult(input.tabId, input.args)),
  respondPermission: publicProcedure
    .input(z.object({ tabId: z.string(), args: permissionArgs }))
    .mutation(({ input }) => ops().respondPermission(input.tabId, input.args)),
  interrupt: publicProcedure.input(chatCreateOpts).mutation(({ input }) => ops().interrupt(input)),
  abortAndPop: publicProcedure
    .input(chatCreateOpts)
    .mutation(({ input }) => ops().abortAndPop(input)),
  // A dry run, but it may start the agent: a mutation.
  rewindPreview: publicProcedure
    .input(rewindOpts)
    .mutation(({ input }) => ops().rewindPreview(input)),
  rewind: publicProcedure
    .input(rewindOpts.extend({ conversation: z.boolean(), files: z.boolean() }))
    .mutation(({ input }) => ops().rewind(input)),
  // Fork from a past message, in this tab (the original stays in Sessions).
  fork: publicProcedure
    .input(chatCreateOpts.extend({ messageId: z.string().min(1).max(200) }))
    .mutation(({ input }) => ops().fork(input)),
  // Sessions picker: run another conversation of this task (this chat's, or the
  // terminal's — a hand-off) in the tab.
  switchConversation: publicProcedure
    .input(chatCreateOpts.extend({ conversationId: z.string().uuid(), sourceMode: z.string() }))
    .mutation(({ input }) => ops().switchConversation(input)),
  // The chat ↔ terminal hand-off: the conversation moves, the other side stops
  // first (never two processes on one conversation).
  continueInTerminal: publicProcedure
    .input(chatCreateOpts)
    .mutation(({ input }) => ops().continueInTerminal(input)),
  continueInChat: publicProcedure
    .input(chatCreateOpts)
    .mutation(({ input }) => ops().continueInChat(input)),
  // Refused because the terminal runs the conversation: stop it, start here.
  takeOver: publicProcedure.input(chatCreateOpts).mutation(({ input }) => ops().takeOver(input)),
  kill: publicProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ input }) => ops().kill(input.tabId)),
  remove: publicProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ input }) => ops().remove(input.tabId)),
  reset: publicProcedure.input(chatCreateOpts).mutation(({ input }) => ops().reset(input)),
  getBufferSince: publicProcedure
    .input(z.object({ tabId: z.string(), afterSeq: z.number() }))
    .query(({ input }) => ops().getBufferSince(input.tabId, input.afterSeq)),
  // Saved events + what is streaming right now, in one snapshot (reload mid-reply).
  getReplay: publicProcedure
    .input(z.object({ tabId: z.string(), afterSeq: z.number() }))
    .query(({ input }) => ops().getReplay(input.tabId, input.afterSeq)),
  // A command the agent runs as a task (plan 3.9): its live output (polled by
  // the command card while it runs and is on screen), stop, move to background.
  commandTaskOutput: publicProcedure
    .input(z.object({ tabId: z.string(), taskId: z.string() }))
    .query(({ input }) => ops().commandTaskOutput(input.tabId, input.taskId)),
  stopCommandTask: publicProcedure
    .input(z.object({ tabId: z.string(), taskId: z.string() }))
    .mutation(({ input }) => ops().stopCommandTask(input.tabId, input.taskId)),
  backgroundCommandTask: publicProcedure
    .input(z.object({ tabId: z.string(), toolUseId: z.string() }))
    .mutation(({ input }) => ops().backgroundCommandTask(input.tabId, input.toolUseId)),
  getInfo: publicProcedure
    .input(z.object({ tabId: z.string() }))
    .query(({ input }) => ops().getInfo(input.tabId)),
  inspectPermissions: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().inspectPermissions(input.taskId, input.mode)),

  // Permission mode / model / effort / collaboration / fast mode
  getMode: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getMode(input.taskId, input.mode)),
  getAutoEligibility: publicProcedure.query(() => ops().getAutoEligibility()),
  setMode: publicProcedure
    .input(chatCreateOpts.extend({ chatMode: z.string() }))
    .mutation(({ input }) => ops().setMode(input)),
  getModel: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getModel(input.taskId, input.mode)),
  setModel: publicProcedure
    .input(chatCreateOpts.extend({ chatModel: z.string() }))
    .mutation(({ input }) => ops().setModel(input)),
  getEffort: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getEffort(input.taskId, input.mode)),
  setEffort: publicProcedure
    .input(chatCreateOpts.extend({ chatEffort: z.string() }))
    .mutation(({ input }) => ops().setEffort(input)),
  getCollaboration: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getCollaboration(input.taskId, input.mode)),
  setCollaboration: publicProcedure
    .input(chatCreateOpts.extend({ chatCollaboration: z.string() }))
    .mutation(({ input }) => ops().setCollaboration(input)),
  getFastMode: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getFastMode(input.taskId, input.mode)),
  setFastMode: publicProcedure
    .input(chatCreateOpts.extend({ chatFastMode: z.boolean() }))
    .mutation(({ input }) => ops().setFastMode(input)),

  // Project metadata
  listSkills: publicProcedure
    .input(z.object({ cwd: z.string() }))
    .query(({ input }) => ops().listSkills(input.cwd)),
  listCommands: publicProcedure
    // `nested` adds sub-folder commands (`sub/z.md` → `/sub:z`) — Claude chat only.
    .input(z.object({ cwd: z.string(), nested: z.boolean().optional() }))
    .query(({ input }) => ops().listCommands(input.cwd, { nested: input.nested })),
  listAgents: publicProcedure
    .input(z.object({ cwd: z.string() }))
    .query(({ input }) => ops().listAgents(input.cwd)),
  listFiles: publicProcedure
    .input(z.object({ cwd: z.string(), query: z.string(), limit: z.number().optional() }))
    .query(({ input }) => ops().listFiles(input.cwd, input.query, input.limit)),
  bumpAutocompleteUsage: publicProcedure
    .input(z.object({ source: z.string(), name: z.string() }))
    .mutation(({ input }) => ops().bumpAutocompleteUsage(input.source, input.name)),
  getAutocompleteUsage: publicProcedure.query(() => ops().getAutocompleteUsage()),
  /** Last slash-command list the mode's CLI advertised in the task's project (null = none yet). */
  getCliSnapshot: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getCliSnapshot(input.taskId, input.mode)),

  // Queue (mirrors the `chat:queue:*` IPC channels)
  queue: router({
    list: publicProcedure
      .input(z.object({ tabId: z.string() }))
      .query(({ input }) => queueOps().list(input.tabId)),
    push: publicProcedure
      .input(
        z.object({
          tabId: z.string(),
          send: z.string(),
          original: z.string(),
          // Client-minted: the queued message's id becomes its outbox id when sent.
          id: z.string().min(1).max(200).optional(),
          content: z.array(userContentBlock).min(1).optional()
        })
      )
      .mutation(({ input }) =>
        queueOps().push(input.tabId, input.send, input.original, {
          ...(input.id ? { id: input.id } : {}),
          ...(input.content ? { content: input.content } : {})
        })
      ),
    remove: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => queueOps().remove(input.id)),
    clear: publicProcedure
      .input(z.object({ tabId: z.string() }))
      .mutation(({ input }) => queueOps().clear(input.tabId))
  }),

  // Streaming subscriptions — replace the 4 `webContents.send` broadcasts.
  // Source emitters are dual-emitted in the terminal domain; IPC stays until
  // the renderer cuts over (slice 5).
  //
  // `tabIds` is an OPTIONAL server-side filter — same reasoning as `pty.onData`
  // (pty-router.ts): this is otherwise every chat event on the hub, filtered
  // only client-side. Omitted (every existing caller) reproduces today's
  // unfiltered behavior exactly.
  onEvent: publicProcedure
    .input(z.object({ tabIds: z.array(z.string()).optional() }).optional())
    .subscription(({ input }) =>
      // `live` is set on live-only events (streaming fragments, `sending`): they
      // follow saved event `seq` and are never in `getBufferSince`.
      observable<{ tabId: string; event: unknown; seq: number; live?: number }>((emit) => {
        const filter = input?.tabIds
        const handler = (tabId: string, event: unknown, seq: number, live?: number): void => {
          if (filter && !filter.includes(tabId)) return
          emit.next(live === undefined ? { tabId, event, seq } : { tabId, event, seq, live })
        }
        const ev = getChatDeps().events
        ev.on('event', handler)
        return () => {
          ev.off('event', handler)
        }
      })
    ),
  onExit: publicProcedure.subscription(() =>
    observable<{ tabId: string; sessionId: string; code: number | null; signal: string | null }>(
      (emit) => {
        const handler = (
          tabId: string,
          sessionId: string,
          code: number | null,
          signal: string | null
        ): void => {
          emit.next({ tabId, sessionId, code, signal })
        }
        const ev = getChatDeps().events
        ev.on('exit', handler)
        return () => {
          ev.off('exit', handler)
        }
      }
    )
  ),
  onQueueChanged: publicProcedure.subscription(() =>
    observable<{ tabId: string }>((emit) => {
      const handler = (tabId: string): void => {
        emit.next({ tabId })
      }
      const ev = getChatDeps().queueEvents
      ev.on('queue-changed', handler)
      return () => {
        ev.off('queue-changed', handler)
      }
    })
  ),
  onQueueDrained: publicProcedure.subscription(() =>
    observable<{ tabId: string; original: string }>((emit) => {
      const handler = (tabId: string, original: string): void => {
        emit.next({ tabId, original })
      }
      const ev = getChatDeps().queueEvents
      ev.on('queue-drained', handler)
      return () => {
        ev.off('queue-drained', handler)
      }
    })
  )
})

export type ChatRouter = typeof chatRouter
/** The key api mounts `chatRouter` at; a client calling `chat.*` types against this. */
export type ChatMounts = { chat: ChatRouter }
