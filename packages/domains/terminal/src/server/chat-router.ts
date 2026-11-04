import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { randomUUID } from 'node:crypto'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { CHAT_IMAGE_MEDIA_TYPES, SIDE_QUESTION_MAX_CHARS } from '@slayzone/terminal-contracts'
import { getChatDeps } from './chat-router-deps'

const ops = (): ReturnType<typeof getChatDeps>['ops'] => getChatDeps().ops
const chatContext = z.object({ taskId: z.string().optional(), tabId: z.string().optional() })
const catalog = () => getChatDeps().catalog
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
      updatedPermissions: z.array(z.unknown()).optional(),
      scope: z.literal('session').optional(),
      amendment: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('execpolicy'), command: z.array(z.string()) }),
          z.object({
            kind: z.literal('network'),
            host: z.string(),
            action: z.enum(['allow', 'deny'])
          })
        ])
        .optional()
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

/**
 * An attached file: a reference to an artifact of the tab's task (the server
 * checks it is one, and reads the bytes itself — see `chat-attachment-guard.ts`).
 */
const chatAttachment = z
  .object({
    artifactId: z.string().min(1).max(200),
    contentHash: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(512),
    kind: z.enum(['image', 'pdf', 'text']),
    mediaType: z.enum([...CHAT_IMAGE_MEDIA_TYPES, 'application/pdf', 'text/plain']),
    size: z.number().int().nonnegative()
  })
  .strict()
/** A chat tab's draft: text + attached files (references). */
const chatDraft = z.object({
  text: z.string().max(1_000_000),
  attachments: z.array(chatAttachment).max(100)
})
const scrollAnchor = z.union([
  z.object({ atBottom: z.literal(true) }).strict(),
  z
    .object({
      atBottom: z.literal(false),
      key: z.string().min(1).max(500),
      offsetPx: z.number(),
      row: z.number().int().nonnegative().optional()
    })
    .strict()
])

/** One block of a user message: text, or an attached file. */
const userContentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('attachment'), attachment: chatAttachment })
])
/**
 * A user message: the client mints the id (the outbox and the CLI's `uuid` key
 * on it), so a retry of the same id is the same message. Legacy `{text}` (no
 * id) is still accepted and gets a server id.
 */
const sendInput = z.union([
  z.object({
    tabId: z.string(),
    operationId: z.string().min(1).max(200).optional(),
    message: z.object({
      id: z.string().min(1).max(200),
      content: z.array(userContentBlock).min(1)
    })
  }),
  z.object({
    tabId: z.string(),
    text: z.string(),
    operationId: z.string().min(1).max(200).optional()
  })
])

/** A past user message + which side of it a rewind keeps (chat A, plan 3.3). */
const rewindOpts = chatCreateOpts.extend({
  messageId: z.string().min(1).max(200),
  scope: z.enum(['before', 'after'])
})

const computer = () => {
  const value = getChatDeps().computers
  if (!value) throw new Error('Computer chat storage is unavailable')
  return value
}
const backupTarget = z.object({ computerId: z.string().min(1) })
const backupId = backupTarget.extend({ id: z.string().uuid() })
const archiveTarget = backupTarget.extend({ archiveId: z.string().uuid() })
const archiveConversation = archiveTarget.extend({ conversationId: z.string().min(1) })
function testing() {
  if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
  const port = getChatDeps().testing
  if (!port) throw new Error('Test computer storage unavailable')
  return port
}
export const chatRouter = router({
  testSeedEvents: publicProcedure
    .input(
      z.object({
        tabId: z.string().min(1),
        fromSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        events: z.array(z.object({ kind: z.string().min(1).max(100) }).passthrough()).max(1000)
      })
    )
    .mutation(async ({ input }) => {
      await testing().seedEvents(input.tabId, input.fromSeq, input.events)
      return { ok: true }
    }),
  testReadEvents: publicProcedure
    .input(
      z.object({
        tabId: z.string().min(1),
        afterSeq: z.number().int().min(-1),
        limit: z.number().int().min(1).max(1000)
      })
    )
    .query(({ input }) => testing().readEvents(input.tabId, input.afterSeq, input.limit)),
  testProjection: publicProcedure
    .input(
      z.object({
        tabId: z.string().min(1),
        action: z.enum(['read', 'corrupt-page', 'corrupt-checkpoint'])
      })
    )
    .mutation(({ input }) => testing().projection(input.tabId, input.action)),
  testSeedPrompts: publicProcedure
    .input(
      z.object({
        taskId: z.string().min(1),
        prompts: z
          .array(
            z.object({
              id: z.string().min(1).max(200),
              agentId: z.string().min(1).max(100),
              text: z.string().max(1_000_000),
              cliSessionId: z.string().max(200).nullable(),
              createdAt: z.number().int().nonnegative()
            })
          )
          .max(1000)
      })
    )
    .mutation(async ({ input }) => {
      await testing().seedPrompts(input.taskId, input.prompts)
      return { ok: true }
    }),
  availability: publicProcedure.input(z.object({ tabId: z.string().min(1) })).query(({ input }) => {
    const read = getChatDeps().availability
    if (!read) throw new Error('Chat availability is unavailable')
    return read(input.tabId)
  }),
  backups: router({
    list: publicProcedure
      .input(backupTarget)
      .query(({ input }) => computer().listBackups(input.computerId)),
    create: publicProcedure
      .input(backupId)
      .mutation(({ input }) => computer().createBackup(input.computerId, input.id)),
    delete: publicProcedure
      .input(backupId)
      .mutation(({ input }) => computer().deleteBackup(input.computerId, input.id)),
    restore: publicProcedure
      .input(backupTarget.extend({ backupId: z.string().uuid(), archiveId: z.string().uuid() }))
      .mutation(({ input }) =>
        computer().restoreBackup(input.computerId, input.backupId, input.archiveId)
      ),
    settings: publicProcedure
      .input(backupTarget)
      .query(({ input }) => computer().backupSettings(input.computerId)),
    configure: publicProcedure
      .input(
        backupTarget.extend({
          settings: z.object({
            autoEnabled: z.boolean(),
            intervalMinutes: z.number().int().min(15),
            maxAutoBackups: z.number().int().nonnegative()
          })
        })
      )
      .mutation(({ input }) => computer().configureBackups(input.computerId, input.settings))
  }),
  archives: router({
    file: publicProcedure
      .input(
        archiveConversation.extend({
          artifactId: z.string().min(1).max(200),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/)
        })
      )
      .query(({ input }) =>
        computer().archiveFile(
          input.computerId,
          input.archiveId,
          input.conversationId,
          input.artifactId,
          input.contentHash
        )
      ),
    list: publicProcedure
      .input(backupTarget)
      .query(({ input }) => computer().listArchives(input.computerId)),
    conversations: publicProcedure
      .input(archiveTarget)
      .query(({ input }) => computer().archiveConversations(input.computerId, input.archiveId)),
    read: publicProcedure
      .input(archiveConversation.extend({ afterSeq: z.number().int().default(-1) }))
      .query(({ input }) =>
        computer().archiveRead(
          input.computerId,
          input.archiveId,
          input.conversationId,
          input.afterSeq
        )
      ),
    records: publicProcedure
      .input(archiveConversation.extend({ afterCursor: z.number().int().nonnegative().default(0) }))
      .query(({ input }) =>
        computer().archiveRecords(
          input.computerId,
          input.archiveId,
          input.conversationId,
          input.afterCursor
        )
      ),
    attachment: publicProcedure
      .input(archiveConversation.extend({ ref: chatAttachment }))
      .query(({ input }) =>
        computer().archiveAttachment(
          input.computerId,
          input.archiveId,
          input.conversationId,
          input.ref
        )
      )
  }),
  workspaceChanges: router({
    get: publicProcedure
      .input(z.object({ tabId: z.string(), captureId: z.string().max(200) }))
      .query(({ input }) => ops().getWorkspaceChanges(input.tabId, input.captureId)),
    getFileDiff: publicProcedure
      .input(
        z.object({
          tabId: z.string(),
          captureId: z.string().max(200),
          path: z.string().max(10_000)
        })
      )
      .query(({ input }) => ops().getWorkspaceFileDiff(input.tabId, input.captureId, input.path))
  }),
  // Test-only (PLAYWRIGHT): shorten the chat watchdog for one spec; `null` restores
  // the defaults. Same gate as pty-router's test procedures.
  testSetWatchdogTimings: publicProcedure
    .input(z.object({ timings: watchdogTimings.nullable() }))
    .mutation(async ({ input }) => {
      if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
      await ops().testSetWatchdogTimings(input.timings)
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
  restart: publicProcedure.input(chatCreateOpts).mutation(({ input }) => ops().restart(input)),
  send: publicProcedure.input(sendInput).mutation(({ input }) => {
    const message =
      'message' in input
        ? input.message
        : { id: randomUUID(), content: [{ type: 'text' as const, text: input.text }] }
    return input.operationId
      ? ops().send(input.tabId, message, input.operationId)
      : ops().send(input.tabId, message)
  }),
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
  threads: router({
    onChanged: publicProcedure.input(z.object({ tabId: z.string() })).subscription(({ input }) =>
      observable<void>((emit) => {
        const handler = (tabId: string) => {
          if (tabId === input.tabId) emit.next()
        }
        getChatDeps().events.on('threads-changed', handler)
        return () => getChatDeps().events.off('threads-changed', handler)
      })
    ),
    list: publicProcedure
      .input(chatCreateOpts.extend({ conversationId: z.string().nullish() }))
      .query(({ input }) => ops().listThreads(input)),
    create: publicProcedure
      .input(
        chatCreateOpts.extend({
          messageId: z.string().min(1).max(200),
          answerId: z.string().min(1).max(500),
          title: z.string().trim().min(1).max(120),
          text: z.string().trim().min(1).max(1_000_000)
        })
      )
      .mutation(({ input }) => ops().createThread(input))
  }),
  // `/btw`: a side question answered from the conversation, never part of it.
  sideQuestion: router({
    // May start the agent: a mutation. Resolves with the answer (seconds).
    ask: publicProcedure
      .input(
        chatCreateOpts.extend({
          requestId: z.string().min(1).max(200),
          question: z.string().trim().min(1).max(SIDE_QUESTION_MAX_CHARS),
          history: z
            .array(
              z.object({
                question: z.string().max(SIDE_QUESTION_MAX_CHARS),
                answer: z.string().max(200_000)
              })
            )
            .max(50)
        })
      )
      .mutation(({ input }) => ops().askSideQuestion(input)),
    cancel: publicProcedure
      .input(z.object({ tabId: z.string(), requestId: z.string().min(1).max(200) }))
      .mutation(({ input }) => ops().cancelSideQuestion(input))
  }),
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
  // Paged history: open from the hub's timeline projection (`full`: use getReplay),
  // rows of older pages as of the client's newest event, pages that may hold a query.
  openTimeline: publicProcedure
    .input(z.object({ tabId: z.string(), version: z.string() }))
    .query(({ input }) => ops().openTimeline(input.tabId, input.version)),
  timelinePages: publicProcedure
    .input(
      z.object({
        tabId: z.string(),
        pages: z.array(z.number().int().nonnegative()).max(512),
        asOfSeq: z.number().int(),
        epoch: z.number().int()
      })
    )
    .query(({ input }) =>
      ops().timelinePages(input.tabId, input.pages, input.asOfSeq, input.epoch)
    ),
  searchTimeline: publicProcedure
    .input(z.object({ tabId: z.string(), query: z.string().max(1000) }))
    .query(({ input }) => ops().searchTimeline(input.tabId, input.query)),
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
  // One background sub-agent (the composer's Stop), by its row's tool_use_id.
  stopSubAgent: publicProcedure
    .input(z.object({ tabId: z.string(), toolUseId: z.string() }))
    .mutation(({ input }) => ops().stopSubAgent(input.tabId, input.toolUseId)),
  // `mode`: only a session of that provider counts — a tab switching provider
  // keeps its old session until the new one spawns.
  getInfo: publicProcedure
    .input(z.object({ tabId: z.string(), mode: z.string().optional() }))
    .query(({ input }) => ops().getInfo(input.tabId, input.mode)),
  inspectPermissions: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().inspectPermissions(input.taskId, input.mode)),

  // Permission mode / model / effort / collaboration / fast mode
  getMode: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getMode(input.taskId, input.mode)),
  getAutoEligibility: publicProcedure
    .input(chatContext.optional())
    .query(({ input }) => catalog()?.getAutoEligibility(input ?? {}) ?? ops().getAutoEligibility()),
  setMode: publicProcedure
    .input(chatCreateOpts.extend({ chatMode: z.string(), stopAndResume: z.boolean().optional() }))
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
  decidePlan: publicProcedure
    .input(
      chatCreateOpts.extend({
        planId: z.string(),
        decision: z.enum(['implement', 'keep-planning']),
        messageId: z.string().optional()
      })
    )
    .mutation(({ input }) => ops().decidePlan(input)),
  getFastMode: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getFastMode(input.taskId, input.mode)),
  setFastMode: publicProcedure
    .input(chatCreateOpts.extend({ chatFastMode: z.boolean() }))
    .mutation(({ input }) => ops().setFastMode(input)),

  // Project metadata
  listSkills: publicProcedure
    .input(z.object({ cwd: z.string(), ...chatContext.shape }))
    .query(({ input }) => catalog()?.listSkills(input, input.cwd) ?? ops().listSkills(input.cwd)),
  listCommands: publicProcedure
    // `nested` adds sub-folder commands (`sub/z.md` → `/sub:z`) — Claude chat only.
    .input(z.object({ cwd: z.string(), nested: z.boolean().optional(), ...chatContext.shape }))
    .query(
      ({ input }) =>
        catalog()?.listCommands(input, input.cwd, { nested: input.nested }) ??
        ops().listCommands(input.cwd, { nested: input.nested })
    ),
  listAgents: publicProcedure
    .input(z.object({ cwd: z.string(), ...chatContext.shape }))
    .query(({ input }) => catalog()?.listAgents(input, input.cwd) ?? ops().listAgents(input.cwd)),
  listFiles: publicProcedure
    .input(
      z.object({
        cwd: z.string(),
        query: z.string(),
        limit: z.number().optional(),
        ...chatContext.shape
      })
    )
    .query(
      ({ input }) =>
        catalog()?.listFiles(input, input.cwd, input.query, input.limit) ??
        ops().listFiles(input.cwd, input.query, input.limit)
    ),
  bumpAutocompleteUsage: publicProcedure
    .input(z.object({ source: z.string(), name: z.string(), ...chatContext.shape }))
    .mutation(
      ({ input }) =>
        catalog()?.bumpAutocompleteUsage(input, input.source, input.name) ??
        ops().bumpAutocompleteUsage(input.source, input.name)
    ),
  getAutocompleteUsage: publicProcedure
    .input(chatContext.optional())
    .query(
      ({ input }) => catalog()?.getAutocompleteUsage(input ?? {}) ?? ops().getAutocompleteUsage()
    ),
  /** Last slash-command list the mode's CLI advertised in the task's project (null = none yet). */
  getCliSnapshot: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getCliSnapshot(input.taskId, input.mode)),
  /** The CLI's command descriptions + argument hints in the task's project (null = none yet). */
  getCliCommandDetails: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getCliCommandDetails(input.taskId, input.mode)),
  /**
   * The models the mode offers: Claude's fixed list, or the models the Codex CLI
   * last reported for the task's project (`model/list`; [] until one ran).
   */
  getModels: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getModels(input.taskId, input.mode)),

  // A tab's composer state: draft + scroll anchor, restored after a remount / reload.
  tabState: router({
    get: publicProcedure
      .input(z.object({ tabId: z.string(), expectedMode: z.string().optional() }))
      .query(({ input }) =>
        input.expectedMode
          ? ops().getTabState(input.tabId, { expectedMode: input.expectedMode })
          : ops().getTabState(input.tabId)
      ),
    saveDraft: publicProcedure
      .input(
        z.object({
          tabId: z.string(),
          draft: chatDraft,
          expectedMode: z.string().optional(),
          expectedOwnership: z
            .object({ id: z.string().min(1), epoch: z.number().int().positive() })
            .optional()
        })
      )
      .mutation(({ input }) =>
        input.expectedMode || input.expectedOwnership
          ? ops().saveTabDraft(input.tabId, input.draft, {
              expectedMode: input.expectedMode,
              expectedOwnership: input.expectedOwnership
            })
          : ops().saveTabDraft(input.tabId, input.draft)
      ),
    saveScroll: publicProcedure
      .input(
        z.object({
          tabId: z.string(),
          anchor: scrollAnchor,
          expectedMode: z.string().optional(),
          expectedOwnership: z
            .object({ id: z.string().min(1), epoch: z.number().int().positive() })
            .optional()
        })
      )
      .mutation(({ input }) =>
        input.expectedMode || input.expectedOwnership
          ? ops().saveTabScroll(input.tabId, input.anchor, {
              expectedMode: input.expectedMode,
              expectedOwnership: input.expectedOwnership
            })
          : ops().saveTabScroll(input.tabId, input.anchor)
      )
  }),

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
          expectedMode: z.string().min(1).max(200).optional(),
          expectedConversationId: z.string().min(1).max(200).optional(),
          // Client-minted: the queued message's id becomes its outbox id when sent.
          id: z.string().min(1).max(200).optional(),
          content: z.array(userContentBlock).min(1).optional()
        })
      )
      .mutation(({ input }) =>
        queueOps().push(input.tabId, input.send, input.original, {
          ...(input.id ? { id: input.id } : {}),
          ...(input.expectedMode ? { expectedMode: input.expectedMode } : {}),
          ...(input.expectedConversationId
            ? { expectedConversationId: input.expectedConversationId }
            : {}),
          ...(input.content ? { content: input.content } : {})
        })
      ),
    /** Rewrite a queued message (an edit); false when it was already sent. */
    update: publicProcedure
      .input(
        z.object({
          id: z.string(),
          send: z.string(),
          original: z.string(),
          content: z.array(userContentBlock).min(1)
        })
      )
      .mutation(({ input }) =>
        queueOps().update(input.id, {
          send: input.send,
          original: input.original,
          content: input.content
        })
      ),
    move: publicProcedure
      .input(z.object({ id: z.string(), toIndex: z.number().int().nonnegative() }))
      .mutation(({ input }) => queueOps().move(input.id, input.toIndex)),
    /** Hold a message while it is edited (renew while the editor is open); false when already sent. */
    hold: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => queueOps().hold(input.id)),
    release: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => queueOps().release(input.id)),
    /**
     * Add a queued message to the running turn ("Send now"): the
     * agent takes it after its current tool call. `ok: false` + why when it
     * can't (the message stays queued).
     */
    steer: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => queueOps().steer(input.id)),
    remove: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => queueOps().remove(input.id)),
    clear: publicProcedure
      .input(z.object({ tabId: z.string() }))
      .mutation(({ input }) => queueOps().clear(input.tabId))
  }),

  // `tabId` optional like every filtered stream: omitted = every tab's signal; the
  // owner policy checks a given tabId and filters each event by its tab either way.
  onReplayRequired: publicProcedure
    .input(z.object({ tabId: z.string() }).optional())
    .subscription(({ input }) =>
      observable<{ tabId: string; generation: string }>((emit) => {
        const handler = (tabId: string, generation: string): void => {
          if (!input || tabId === input.tabId) emit.next({ tabId, generation })
        }
        const ev = getChatDeps().events
        ev.on('replay-required', handler)
        return () => {
          ev.off('replay-required', handler)
        }
      })
    ),
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
      // follow saved event `seq` and are never in `getBufferSince`. `at` is set on
      // saved events: when they were saved (ms), the time their rows show.
      observable<{ tabId: string; event: unknown; seq: number; live?: number; at?: number }>(
        (emit) => {
          const filter = input?.tabIds
          const handler = (
            tabId: string,
            event: unknown,
            seq: number,
            live?: number,
            at?: number
          ): void => {
            if (filter && !filter.includes(tabId)) return
            emit.next(
              live !== undefined
                ? { tabId, event, seq, live }
                : at !== undefined
                  ? { tabId, event, seq, at }
                  : { tabId, event, seq }
            )
          }
          const ev = getChatDeps().events
          ev.on('event', handler)
          return () => {
            ev.off('event', handler)
          }
        }
      )
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
