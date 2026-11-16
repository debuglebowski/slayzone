/** Canonical computer chat request schema, shared by host validation and compiled owner groups. */
import { z } from 'zod'
import {
  chatIdentitySchema,
  chatBootstrapSchema,
  chatRouteSchema,
  chatAttachmentSchema,
  chatTransferManifestSchema,
  chatTabTransitionSchema,
  dataImportRequestSchema,
  ledgerRequestSchema,
  turnsRequestSchema,
  taskPathsRequestSchema
} from '../shared'
import { chatProcessControlSchema, chatControlPreparationSchema } from '../shared/protocol'
import { computerArtifactRequestSchema } from './artifacts'
import { chatTestRequestSchema } from './computer-testing-schema'
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SCROLLBACK_NAME = /^[a-f0-9]{40}\.txt$/
const ROLLOUT_NAME = /^rollout-[A-Za-z0-9._:-]{1,120}\.jsonl$/
const ROLLOUT_DATE = /^\d{4}\/\d{2}\/\d{2}$/

export const sessionMoveFileRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude-transcript'), sessionId: z.string().regex(SAFE_SESSION_ID) }),
  z.object({ kind: z.literal('pty-history'), name: z.string().regex(SCROLLBACK_NAME) }),
  z.object({
    kind: z.literal('codex-rollout'),
    sessionId: z.string().regex(SAFE_SESSION_ID),
    /** `YYYY/MM/DD` under the Codex sessions folder. */
    date: z.string().regex(ROLLOUT_DATE),
    name: z.string().regex(ROLLOUT_NAME)
  })
])
export type SessionMoveFileRef = z.infer<typeof sessionMoveFileRefSchema>

export const computerRequestSchema = z.discriminatedUnion('kind', [
  ...chatControlPreparationSchema.options,
  chatProcessControlSchema,
  ...chatTestRequestSchema.options,
  z.object({
    kind: z.literal('diagnostics.configure'),
    enabled: z.boolean(),
    verbose: z.boolean()
  }),
  z.object({
    kind: z.literal('retention.configure'),
    days: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  }),
  z.object({ kind: z.literal('conversation.delete'), identity: chatIdentitySchema }),
  z.object({ kind: z.literal('conversation.transition'), value: chatTabTransitionSchema }),
  z.object({
    kind: z.literal('hook.capture'),
    hook: z.object({
      agentId: z.enum(['claude-code', 'codex', 'gemini', 'antigravity', 'opencode']),
      mode: z.string(),
      hookEvent: z.string(),
      taskId: z.string(),
      sessionId: z.string().optional(),
      cwd: z.string().optional(),
      raw: z.unknown().optional()
    })
  }),
  z.object({ kind: z.literal('test.reset') }),
  /**
   * Which tabs' full events this hub wants (docs/direct-link.md): `all`, or only
   * `tabIds` — those a hub client watches. Saved events are always reported as an
   * `event-signal`. Until a hub says otherwise: all.
   */
  z.object({
    kind: z.literal('relay.watch'),
    all: z.boolean(),
    tabIds: z.array(z.string().min(1).max(200)).max(10_000)
  }),
  z.object({ kind: z.literal('artifact.invoke'), value: computerArtifactRequestSchema }),
  z.object({ kind: z.literal('inventory') }),
  /** Hub-held computer-only data handed to this computer once (robustness plan §9). */
  z.object({ kind: z.literal('data.import'), value: dataImportRequestSchema }),
  /** One operation on this computer's agent-session ledger (robustness plan §9, P0). */
  z.object({ kind: z.literal('ledger'), value: ledgerRequestSchema }),
  /** One agent-turn operation (record a boundary, list a checkout's turns; §9, P0). */
  z.object({ kind: z.literal('turns'), value: turnsRequestSchema }),
  /** One task-path operation (set / inherit / clear / get; §9, P0, Phase 7a). */
  z.object({ kind: z.literal('taskPaths'), value: taskPathsRequestSchema }),
  /** A read of one task's computer-only data, relayed for a client (`DirectTaskDataService`). */
  z.object({
    kind: z.literal('taskData'),
    taskId: z.string().min(1).max(200),
    request: z.unknown()
  }),
  z.object({ kind: z.literal('metadata.snapshot'), id: z.string() }),
  z.object({ kind: z.literal('backup.list') }),
  z.object({ kind: z.literal('backup.create'), id: z.string().uuid() }),
  z.object({ kind: z.literal('backup.delete'), id: z.string().uuid() }),
  z.object({
    kind: z.literal('backup.restore'),
    backupId: z.string().uuid(),
    archiveId: z.string().uuid()
  }),
  z.object({ kind: z.literal('backup.settings') }),
  // Chat store compaction (fu-2): exact shapes, nothing else accepted.
  z.object({ kind: z.literal('storage.status') }).strict(),
  z.object({ kind: z.literal('storage.compact') }).strict(),
  z.object({ kind: z.literal('storage.cancel') }).strict(),
  z.object({
    kind: z.literal('backup.configure'),
    settings: z.object({
      autoEnabled: z.boolean(),
      intervalMinutes: z.number().int().min(15),
      maxAutoBackups: z.number().int().nonnegative()
    })
  }),
  z.object({ kind: z.literal('archive.list') }),
  z.object({ kind: z.literal('faults.list') }),
  z.object({
    kind: z.enum(['faults.retry', 'faults.discard']),
    ref: z.object({
      source: z.enum(['ledger', 'quarantine']),
      pass: z.string().min(1).max(128),
      key: z.string().min(1).max(512)
    })
  }),
  z.object({ kind: z.literal('folders.inventory'), after: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('folders.delete'),
    taskId: z.string().min(1).max(200),
    folderIds: z.array(z.string().min(1).max(200)).min(1).max(500)
  }),
  z.object({ kind: z.literal('archive.conversations'), archiveId: z.string().uuid() }),
  z.object({
    kind: z.literal('archive.file'),
    archiveId: z.string().uuid(),
    conversationId: z.string(),
    artifactId: z.string().min(1).max(200),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  z.object({
    kind: z.literal('archive.read'),
    archiveId: z.string().uuid(),
    conversationId: z.string(),
    afterSeq: z.number().int()
  }),
  z.object({
    kind: z.literal('archive.records'),
    archiveId: z.string().uuid(),
    conversationId: z.string(),
    afterCursor: z.number().int().nonnegative()
  }),
  z.object({
    kind: z.literal('archive.attachment'),
    archiveId: z.string().uuid(),
    conversationId: z.string(),
    ref: chatAttachmentSchema
  }),
  z.object({
    kind: z.literal('archive.blob'),
    archiveId: z.string().uuid(),
    conversationId: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative()
  }),

  z.object({
    kind: z.literal('task.lifecycle'),
    taskId: z.string(),
    state: z.enum(['active', 'paused', 'deleted']),
    revision: z.number().int().positive()
  }),
  z.object({
    kind: z.literal('task.erase'),
    jobId: z.string().uuid(),
    taskId: z.string().min(1).max(200),
    revision: z.number().int().positive()
  }),
  z.object({
    kind: z.literal('migration.checkpoint'),
    identity: chatIdentitySchema,
    migrationId: z.string(),
    candidate: z
      .array(
        z.object({
          kind: z.enum(['settings']),
          id: z.string(),
          value: z.unknown(),
          at: z.number().int()
        })
      )
      .optional()
  }),
  z.object({
    kind: z.literal('attachment.has'),
    route: chatRouteSchema,
    ref: chatAttachmentSchema
  }),
  z.object({
    kind: z.literal('catalog'),
    method: z.enum([
      'getAutoEligibility',
      'listSkills',
      'listCommands',
      'listAgents',
      'listFiles',
      'bumpAutocompleteUsage',
      'getAutocompleteUsage'
    ]),
    args: z.array(z.unknown()),
    route: chatRouteSchema.optional(),
    /** The task a folder list is for when its chat is not open yet (§9 Phase 7c). */
    scope: z
      .object({
        taskId: z.string().min(1).max(200),
        projectId: z.string().min(1).max(200).nullable()
      })
      .optional(),
    operationId: z.string().optional()
  }),
  z.object({ kind: z.literal('sessions') }),
  z
    .object({
      kind: z.literal('prompt.summaries'),
      taskId: z.string(),
      conversationIds: z.array(z.string()).max(500).optional(),
      // FU5: every provider conversation of the task in ONE answer (bounded by the
      // task's own sessions). Asked only of a computer that advertised
      // `promptSummariesAll`; exactly one of the two.
      all: z.literal(true).optional()
    })
    .refine((r) => (r.all === true) !== (r.conversationIds !== undefined), {
      message: 'prompt.summaries names its conversations or asks for all of them'
    }),
  z.object({
    kind: z.literal('prompts'),
    taskId: z.string(),
    agentId: z.string().optional(),
    excluded: z.array(z.object({ mode: z.string(), conversationId: z.string() })).optional()
  }),
  z.object({ kind: z.literal('transfer.begin'), manifest: chatTransferManifestSchema }),
  z.object({
    kind: z.literal('transfer.chunk'),
    id: z.string(),
    offset: z.number().int().nonnegative(),
    data: z.string().max(350000)
  }),
  z.object({ kind: z.literal('transfer.finish'), id: z.string() }),
  // A task's sessions leaving for another hub (slice 4a): this computer hands out its
  // chats as transfers + its ledger; the target takes them with transfer.* above.
  z.object({
    kind: z.literal('sessionMove.export'),
    moveId: z.string().min(1).max(80),
    taskId: z.string().min(1).max(200)
  }),
  z.object({
    kind: z.literal('sessionMove.read'),
    moveId: z.string().min(1).max(80),
    conversationId: z.string().min(1).max(500),
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(262144)
  }),
  z.object({ kind: z.literal('sessionMove.discard'), moveId: z.string().min(1).max(80) }),
  // The task's sessions are kept elsewhere now: this computer lets go of them (no tombstone).
  z.object({ kind: z.literal('sessionMove.forget'), taskId: z.string().min(1).max(200) }),
  // The files beside the chat (Claude transcripts, terminal scrollback), copied like a
  // move's artifact files.
  z.object({
    kind: z.literal('sessionMove.files'),
    taskId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200)
  }),
  z.object({
    kind: z.literal('sessionMove.fileRead'),
    taskId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    ref: sessionMoveFileRefSchema,
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(262144)
  }),
  z.object({
    kind: z.literal('sessionMove.fileMissing'),
    taskId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    entries: z
      .array(
        z.object({
          ref: sessionMoveFileRefSchema,
          size: z.number().int().nonnegative(),
          hash: z.string().regex(/^[a-f0-9]{64}$/)
        })
      )
      .max(10_000)
  }),
  z.object({
    kind: z.literal('sessionMove.fileWrite'),
    taskId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    ref: sessionMoveFileRefSchema,
    offset: z.number().int().nonnegative(),
    data: z.string().max(350000),
    complete: z
      .object({ size: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) })
      .optional()
  }),
  z.object({
    kind: z.literal('migration.activate'),
    id: z.string(),
    epoch: z.number().int().positive(),
    migrationId: z.string(),
    hash: z.string()
  }),
  z.object({ kind: z.literal('migration.verify'), id: z.string() }),
  z.object({ kind: z.literal('migration.prepared'), id: z.string() }),
  z.object({
    kind: z.literal('attachment.put'),
    route: chatRouteSchema,
    ref: chatAttachmentSchema,
    data: z.string().max(14000000)
  }),
  z.object({
    kind: z.literal('attachment.read'),
    route: chatRouteSchema,
    ref: chatAttachmentSchema
  }),
  z.object({ kind: z.literal('inspectTab'), tabId: z.string() }),

  z.object({ kind: z.literal('bootstrap'), value: chatBootstrapSchema }),
  z.object({ kind: z.literal('invoke'), value: z.unknown() }),
  z.object({ kind: z.literal('inspect'), id: z.string().min(1) }),
  z.object({ kind: z.literal('pendingMetadata') }),
  z.object({ kind: z.literal('task.lifecycles') }),
  z.object({
    kind: z.literal('ackMetadata'),
    id: z.string().min(1),
    operationId: z.string().min(1)
  })
])
export type ComputerChatRequest = z.infer<typeof computerRequestSchema>
