import {
  chatSavedSummary,
  type AgentEvent,
  type ResolvedAgentHook,
  type ChatAttachment
} from '@slayzone/terminal-contracts'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { chatTestRequestSchema, handleChatTesting } from './chat-testing'
import {
  createComputerChatRuntime,
  computerArtifactRequestSchema,
  type ChatBootstrap
} from '@slayzone/chat-runtime/server'
import {
  chatIdentitySchema,
  chatBootstrapSchema,
  parseChatInvocation,
  chatRouteSchema,
  chatAttachmentSchema,
  chatTransferManifestSchema,
  chatTabTransitionSchema
} from '@slayzone/chat-runtime/shared'
import {
  createRoutingChatBackend,
  type ComputerGatewayEvents,
  type RoutingGateway
} from '@slayzone/computer-transport/server'
import {
  TypedEventEmitter,
  CHAT_DIRECT_WRITE_EVENT_NAME,
  type ChatDirectWritePayload,
  ComputerNotificationMethods,
  HubToComputerMethods,
  procDataParamsSchema,
  procExitParamsSchema,
  workspaceCaptureBeginSchema,
  workspaceCaptureResultSchema,
  projectNotPlacedError
} from '@slayzone/computer-transport/shared'
import { judgePath, spawnCwd } from '../path-jail'
import { createProcHandlers } from './proc'
import { createClaudeSessionHandlers } from './claude-session'
import { createWorkspaceChangesHandlers } from './workspace-changes'
import type { HandlerContext } from './types'
import { createDirectChatFanout, type DirectChatEvent } from '../direct/chat-fanout'
import { createChatRelayFilter } from '../direct/chat-relay-filter'

/** History reads a direct-link client may make (docs/direct-link.md). */
export const DIRECT_CHAT_READS = new Set([
  'getReplay',
  'openTimeline',
  'timelinePages',
  'searchTimeline'
] as const)
export type DirectChatRead = typeof DIRECT_CHAT_READS extends Set<infer M> ? M : never

/**
 * Commands a direct-link client may send: they need only the computer's ownership
 * check. Everything that needs the hub's coordination (send, queue, rewind, …) and
 * drafts with attachments (the hub seals their bytes) stay hub calls.
 */
export const DIRECT_CHAT_COMMANDS = new Set([
  'respondPermission',
  'sendToolResult',
  'saveTabDraft',
  'saveTabScroll'
] as const)
export type DirectChatCommand = typeof DIRECT_CHAT_COMMANDS extends Set<infer M> ? M : never

/** One hub's chat, as direct-link clients reach it on this computer. */
export interface DirectChatService {
  /**
   * A history read for `tabId`, under the epoch the hub granted. The computer's own
   * ownership check refuses a stale epoch, exactly as for a relayed read.
   */
  read(tabId: string, epoch: number, method: DirectChatRead, args: unknown[]): Promise<unknown>
  /**
   * A command, deduplicated by `operationId`. Then the hub is told (a journaled
   * `chat-direct-write`) so it drains metadata as after a relayed command.
   */
  command(
    tabId: string,
    epoch: number,
    method: DirectChatCommand,
    args: unknown[],
    operationId: string
  ): Promise<unknown>
  /** The tab's events while its epoch is still the granted one; null when it is not. */
  watch(
    tabId: string,
    epoch: number,
    onEvent: (event: DirectChatEvent) => void,
    onEnd: (reason: 'epoch' | 'deleted' | 'disposed') => void
  ): (() => void) | null
}
import type { ProjectPathStore } from '../project-paths'
import type { SpawnAdmission } from '../spawn-admission'

const requestSchema = z.discriminatedUnion('kind', [
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
  z.object({
    kind: z.literal('backup.configure'),
    settings: z.object({
      autoEnabled: z.boolean(),
      intervalMinutes: z.number().int().min(15),
      maxAutoBackups: z.number().int().nonnegative()
    })
  }),
  z.object({ kind: z.literal('archive.list') }),
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
    kind: z.literal('task.lifecycle'),
    taskId: z.string(),
    state: z.enum(['active', 'paused', 'deleted']),
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
    operationId: z.string().optional()
  }),
  z.object({ kind: z.literal('sessions') }),
  z.object({
    kind: z.literal('prompt.summaries'),
    taskId: z.string(),
    conversationIds: z.array(z.string()).max(500)
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
  z.object({
    kind: z.literal('ackMetadata'),
    id: z.string().min(1),
    operationId: z.string().min(1)
  })
])
/** A per-hub runtime. Raw subprocess output never leaves this process. */
export function createChatRuntimeHandlers(opts: {
  ctx: HandlerContext
  stateDir: string
  hubScope: string
  computerId: () => string | null
  getProjectPaths: () => ProjectPathStore | null
  admission?: SpawnAdmission
  hasTaskWork?(taskId: string): boolean
  stopTask?(taskId: string): Promise<void>
}) {
  let closed = false,
    resetting = false
  let instance: ReturnType<typeof createComputerChatRuntime> | null = null
  let localProcs: ReturnType<typeof createProcHandlers> | null = null
  const directFanout = createDirectChatFanout()
  /** Which tabs' full events this hub wants (`relay.watch`); all until it says. */
  const relay = createChatRelayFilter()
  function runtime() {
    if (closed || resetting) throw new Error('Chat runtime is shutting down')
    if (instance) return instance
    const computerId = opts.computerId()
    if (!computerId) throw new Error('Computer identity is unavailable')
    const events = new TypedEventEmitter<ComputerGatewayEvents>()
    const procs = createProcHandlers(
      {
        ...opts.ctx,
        get hookDirectory() {
          return opts.ctx.hookDirectory
        },
        get cliRelay() {
          return opts.ctx.cliRelay
        },
        get agentHookUrl() {
          return opts.ctx.agentHookUrl
        },
        get hubAddress() {
          return opts.ctx.hubAddress
        },
        dialer: {
          notify: (method, params) => {
            if (method === ComputerNotificationMethods.procData)
              events.emit('proc.data', { computerId, ...procDataParamsSchema.parse(params) })
            else if (method === ComputerNotificationMethods.procExit)
              events.emit('proc.exit', { computerId, ...procExitParamsSchema.parse(params) })
            return true
          }
        }
      },
      opts.getProjectPaths,
      { admission: opts.admission }
    )
    localProcs = procs
    const gateway: RoutingGateway = {
      events,
      listComputers: () => [],
      request: async <T>(_computerId: string, method: string, params?: unknown) => {
        const handler = procs.handlers[method]
        if (!handler) throw new Error('Unknown local process operation')
        return (await handler(params)) as T
      }
    }
    const backend = createRoutingChatBackend({ gateway, resolveComputerId: () => computerId })
    const session = createClaudeSessionHandlers(opts.ctx, opts.getProjectPaths)
    const workspace = createWorkspaceChangesHandlers(opts.ctx, opts.getProjectPaths)
    function publish(type: string, data: Record<string, unknown>) {
      const tabId =
        typeof data.tabId === 'string'
          ? data.tabId
          : typeof data.sessionId === 'string'
            ? data.sessionId.split(':').slice(1).join(':')
            : null
      const owner = tabId ? instance?.storage.forTab(tabId) : null
      if (type !== 'metadata' && !owner) return
      // Direct-link clients get the tab's events from here, not through the hub.
      if (type === 'event' && owner) {
        const ev = data as { event: unknown; seq: number; live?: number; at?: number }
        directFanout.publish({ tabId: owner.identity.tabId, epoch: owner.identity.epoch }, ev)
        // The hub always learns that an event was saved (history progress, prompts,
        // `slay chat` waits); the event itself only while a hub client watches.
        if (ev.live === undefined) {
          publishToHub(owner, 'event-signal', {
            tabId: owner.identity.tabId,
            saved: chatSavedSummary(ev.event as AgentEvent, ev.seq)
          })
        }
        if (!relay.wantsFull(owner.identity.tabId)) return
      }
      publishToHub(owner ?? null, type, data)
    }
    function publishToHub(
      owner: { identity: { id: string; epoch: number; tabId: string } } | null,
      type: string,
      data: Record<string, unknown>
    ) {
      opts.ctx.dialer.notify(ComputerNotificationMethods.event, {
        name: 'chat-runtime',
        payload: {
          type,
          ...(owner
            ? {
                conversationId: owner.identity.id,
                epoch: owner.identity.epoch,
                tabId: owner.identity.tabId,
                providerSessionId:
                  instance?.transport.getSessionInfo(owner.identity.tabId)?.sessionId ?? null
              }
            : {}),
          ...data
        }
      })
    }
    instance = createComputerChatRuntime({
      stateDir: opts.stateDir,
      hubScope: opts.hubScope,
      computerId,
      hasExternalTaskWork: opts.hasTaskWork,
      sessionReader: async (input) =>
        session[HubToComputerMethods.claudeSessionRead](input) as Promise<{
          found: boolean
          records: Array<Record<string, unknown>>
          omitted: number
        }>,
      transport: {
        backend,
        onStateChange: (sessionId, newState, oldState) =>
          publish('state', {
            sessionId,
            newState,
            oldState,
            hasUserInput: instance?.transport.hasSessionUserInput(sessionId) ?? false
          }),
        onBackgroundJobsChange: (sessionId, count) =>
          publish('background-jobs', { sessionId, count }),
        workspaceCapture: {
          begin: async (ctx) =>
            workspaceCaptureBeginSchema.parse(
              await workspace[HubToComputerMethods.workspaceChangesBegin](ctx)
            ),
          finish: async (ctx) =>
            workspaceCaptureResultSchema.parse(
              await workspace[HubToComputerMethods.workspaceChangesFinish](ctx)
            ),
          discard: async (ctx) => {
            await workspace[HubToComputerMethods.workspaceChangesDiscard](ctx)
          }
        }
      },
      onMetadata: (update) => publish('metadata', { update })
    })
    instance.transport.setAgentStateTabRecorder(
      (tabId, state) =>
        instance?.storage.forTab(tabId)?.state === 'active' &&
        instance.local.metadata(tabId, 'agent-state', { state })
    )
    instance.events.on('event', (tabId, event, seq, live, at) =>
      publish('event', { tabId, event, seq, live, at })
    )
    instance.events.on('exit', (tabId, sessionId, code, signal) =>
      publish('exit', { tabId, sessionId, code, signal })
    )
    instance.events.on('threads-changed', (tabId) => publish('threads-changed', { tabId }))
    instance.events.on('pinned-messages-changed', (tabId) =>
      publish('pinned-messages-changed', { tabId })
    )
    instance.queueEvents.on('queue-changed', (tabId) => publish('queue-changed', { tabId }))
    instance.queueEvents.on('queue-drained', (tabId, original) =>
      publish('queue-drained', { tabId, original })
    )
    return instance
  }
  async function request(raw: unknown): Promise<unknown> {
    const req = requestSchema.parse(raw)
    if (req.kind.startsWith('test.') && process.env.PLAYWRIGHT !== '1')
      throw new Error('test-only handler unavailable')
    if (req.kind !== 'test.reset' && req.kind.startsWith('test.'))
      return handleChatTesting(runtime(), chatTestRequestSchema.parse(req))
    if (req.kind === 'test.reset') {
      if (!process.env.PLAYWRIGHT) throw new Error('Test reset is unavailable')
      resetting = true
      try {
        if (instance) {
          const path = instance.storage.dir
          await instance.close()
          instance = null
          localProcs?.disposeAll()
          localProcs = null
          rmSync(path, { recursive: true, force: true })
        }
        return { ok: true }
      } finally {
        resetting = false
      }
    }
    const r = runtime()
    switch (req.kind) {
      case 'relay.watch':
        relay.configure(req.all, req.tabIds)
        return { ok: true }
      case 'conversation.delete':
        await r.deleteConversation(req.identity)
        directFanout.end(req.identity.tabId, 'deleted')
        return { ok: true }
      case 'conversation.transition':
        return r.transitionTab(req.value)
      case 'hook.capture':
        r.captureHook(req.hook)
        return { ok: true }
      case 'inventory':
        return r.storage
          .inventory()
          .filter((o) => !o.identity.id.startsWith('__'))
          .map((o) => ({
            ...o,
            hasConversationContent: r.storage.hasConversationContent(o.identity.id),
            bootstrapRevision:
              r.storage.getRecord<ChatBootstrap>(o.identity.id, 'settings', 'bootstrap')
                ?.revision ?? 0,
            inbox: !!r.storage.getRecord(o.identity.id, 'settings', 'inbox'),
            tabTransitions: r.storage
              .records(o.identity.id, 'settings')
              .filter((record) => record.id.startsWith('tab-transition:'))
              .map((record) => record.value),
            lifecycle: r.storage.taskLifecycle(o.identity.taskId),
            metadataCounter:
              r.storage.getRecord<number>(o.identity.id, 'settings', 'metadata-counter') ?? 0,
            historySeq: r.storage.nextSeq(o.identity.id) - 1,
            stateVersion: r.storage.stateVersion(o.identity.taskId)
          }))
      case 'metadata.snapshot':
        return r.artifacts.metadata(req.id)
      case 'artifact.invoke':
        return r.artifacts.invoke(req.value)
      case 'backup.list':
        return r.backups.list()
      case 'backup.create':
        return r.backups.create('manual', req.id)
      case 'backup.delete':
        r.backups.delete(req.id)
        return null
      case 'backup.restore':
        return r.backups.restore(req.backupId, req.archiveId)
      case 'backup.settings':
        return r.backups.settings()
      case 'retention.configure':
        r.retention.configure(req.days)
        return { days: r.retention.days }
      case 'diagnostics.configure':
        r.configureDiagnostics({ enabled: req.enabled, verbose: req.verbose })
        return r.diagnosticsConfig()
      case 'backup.configure':
        r.backups.configure(req.settings)
        return null
      case 'archive.list':
        return r.backups.listArchives()
      case 'folders.inventory':
        return r.artifacts.deletedFolderInventory(req.after)
      case 'folders.delete':
        r.artifacts.deleteFolders(req.taskId, req.folderIds)
        return { ok: true }
      case 'archive.conversations':
        return r.backups.conversations(req.archiveId)
      case 'archive.file': {
        const file = r.backups.file(
          req.archiveId,
          req.conversationId,
          req.artifactId,
          req.contentHash
        )
        return { name: file.name, data: file.data.toString('base64') }
      }
      case 'archive.read':
        return r.backups.read(req.archiveId, req.conversationId, req.afterSeq)
      case 'archive.records':
        return r.backups.records(req.archiveId, req.conversationId, req.afterCursor)
      case 'archive.attachment':
        return {
          data: r.backups.attachment(req.archiveId, req.conversationId, req.ref).toString('base64')
        }

      case 'task.lifecycle': {
        const applied = await r.applyTaskLifecycle(req.taskId, req.state, req.revision)
        if (applied.state !== 'active') await opts.stopTask?.(req.taskId)
        return applied
      }
      case 'migration.checkpoint':
        return r.storage.migrationCheckpoint(req.identity, req.migrationId, req.candidate)
      case 'prompts':
        return r.prompts(req.taskId, req.agentId, req.excluded)
      case 'prompt.summaries':
        return r.promptSummaries(req.taskId, req.conversationIds)
      case 'sessions':
        return r.transport.listChatSessions().map((row) => ({
          ...row,
          providerSessionId:
            r.transport.getSessionInfo(row.sessionId.slice(row.taskId.length + 1))?.sessionId ??
            null
        }))
      case 'catalog': {
        let route = req.route
        if (!route) {
          const identity = {
            id: '__slz_catalog__',
            taskId: '__slz_catalog__',
            tabId: '__slz_catalog__',
            mode: 'claude-chat',
            epoch: 1
          }
          r.bootstrap({
            identity,
            projectId: null,
            cwd: spawnCwd(undefined, opts.ctx.config.allowedRoots),
            revision: 1,
            providerConfig: {},
            defaultFlags: null,
            env: {}
          })
          route = { id: identity.id, epoch: 1 }
        }
        const call = parseChatInvocation({
          route,
          target: 'ops',
          method: req.method,
          args: req.args,
          operationId: req.operationId ?? randomUUID()
        })
        if (['listSkills', 'listCommands', 'listAgents', 'listFiles'].includes(req.method)) {
          const owner = r.storage.conversation(route.id),
            bootstrap = owner
              ? r.local.get<ChatBootstrap>(owner.identity.tabId, 'settings', 'bootstrap')
              : null
          call.args[0] = judgePath(
            String(call.args[0] || bootstrap?.cwd || ''),
            opts.ctx.config.allowedRoots
          )
        }
        return r.invoke(call)
      }

      case 'transfer.begin':
        return r.transfers.begin(req.manifest)
      case 'transfer.chunk':
        return r.transfers.chunk(req.id, req.offset, Buffer.from(req.data, 'base64'))
      case 'transfer.finish':
        return r.transfers.finish(req.id)
      case 'migration.verify':
        return { missing: r.attachments.missing(req.id) }
      case 'migration.prepared': {
        const owner = r.storage.conversation(req.id)
        const manifest = r.transfers.resume(req.id)
        if (owner?.state !== 'prepared' || !manifest) return null
        return {
          migrationId: owner.migrationId,
          epoch: owner.identity.epoch,
          hash: owner.migrationHash,
          manifest,
          attachments: r.storage
            .records(req.id, 'attachment')
            .filter((record) => record.kind === 'attachment')
            .map((record) => {
              const { artifactId, contentHash, name, kind, mediaType, size } =
                record.value as ChatAttachment
              return { artifactId, contentHash, name, kind, mediaType, size }
            })
        }
      }
      case 'migration.activate': {
        const owner = r.storage.conversation(req.id)
        if (owner?.state === 'prepared' && r.attachments.missing(req.id).length)
          throw new Error('Migration attachments are incomplete')
        r.storage.activate(req.id, req.migrationId, req.epoch, req.hash)
        r.transfers.collectActivated()
        return { ok: true }
      }
      case 'attachment.has': {
        const owner = r.storage.conversation(req.route.id)
        if (!owner || owner.identity.epoch !== req.route.epoch || owner.state !== 'active')
          throw new Error('Attachment ownership mismatch')
        if (
          !req.ref.contentHash ||
          !r.storage.getRecord(
            req.route.id,
            'attachment',
            `${req.ref.artifactId}:${req.ref.contentHash}`
          )
        )
          return { present: false }
        try {
          await r.attachments.reader.read(req.ref)
          return { present: true }
        } catch {
          return { present: false }
        }
      }
      case 'attachment.put': {
        const owner = r.storage.conversation(req.route.id)
        if (!owner || owner.identity.epoch !== req.route.epoch)
          throw new Error('Attachment ownership mismatch')
        const bytes = Buffer.from(req.data, 'base64')
        if (owner.state === 'prepared') {
          r.attachments.putPrepared(req.route.id, req.route.epoch, req.ref, bytes)
          return req.ref
        }
        if (owner.state !== 'active') throw new Error('Attachment conversation is unavailable')
        return r.attachments.put(owner.identity.tabId, req.ref, bytes)
      }
      case 'attachment.read': {
        const owner = r.storage.conversation(req.route.id)
        if (!owner || owner.identity.epoch !== req.route.epoch || owner.state === 'deleted')
          throw new Error('Attachment ownership mismatch')
        const records = r.storage.records(req.route.id, 'attachment')
        if (
          !records.some(
            (row) =>
              row.kind === 'attachment' &&
              (row.value as { artifactId: string; contentHash: string }).artifactId ===
                req.ref.artifactId &&
              (!req.ref.contentHash ||
                (row.value as { contentHash: string }).contentHash === req.ref.contentHash)
          )
        )
          throw new Error('Attachment does not belong to this conversation')
        return { data: Buffer.from(await r.attachments.reader.read(req.ref)).toString('base64') }
      }
      case 'inspectTab':
        return r.storage.forTab(req.tabId)

      case 'bootstrap': {
        const value = req.value as ChatBootstrap
        const candidate =
          value.cwd ||
          (value.projectId ? opts.getProjectPaths()?.get(value.projectId)?.path : undefined)
        if (!candidate && value.projectId) throw projectNotPlacedError(value.projectId)
        const cwd = spawnCwd(candidate, opts.ctx.config.allowedRoots)
        r.bootstrap({ ...value, cwd })
        return { ok: true, identity: r.storage.conversation(value.identity.id)?.identity }
      }
      case 'invoke': {
        const call = parseChatInvocation(req.value)
        const first = call.args[0]
        if (first && typeof first === 'object' && 'cwd' in first) {
          const o = first as { cwd: string }
          if (o.cwd) o.cwd = judgePath(o.cwd, opts.ctx.config.allowedRoots)
          else {
            const i = r.storage.conversation(call.route.id)?.identity
            const b = i ? r.local.get<ChatBootstrap>(i.tabId, 'settings', 'bootstrap') : null
            if (b) o.cwd = b.cwd
          }
        }
        if (['listSkills', 'listCommands', 'listAgents', 'listFiles'].includes(call.method))
          call.args[0] = judgePath(String(first), opts.ctx.config.allowedRoots)
        return r.invoke(call)
      }
      case 'inspect':
        return r.storage.conversation(req.id)
      case 'pendingMetadata':
        return r.storage
          .findRecords('settings', undefined, { idPrefix: 'metadata:', limit: 500 })
          .map((r) => r.value)
      case 'ackMetadata': {
        const owner = r.storage.conversation(req.id)
        if (!owner) throw new Error('Unknown conversation')
        r.storage.removeRecord(
          req.id,
          owner.identity.epoch,
          'settings',
          `metadata:${req.operationId}`
        )
        return { ok: true }
      }
    }
  }
  const direct: DirectChatService = {
    async read(tabId, epoch, method, args) {
      if (!DIRECT_CHAT_READS.has(method)) throw new Error(`not a direct chat read: ${method}`)
      const r = runtime()
      const owner = r.storage.forTab(tabId)
      if (!owner) throw new Error('No chat conversation for this tab')
      return r.invoke(
        parseChatInvocation({
          route: { id: owner.identity.id, epoch },
          target: 'ops',
          method,
          args
        })
      )
    },
    async command(tabId, epoch, method, args, operationId) {
      if (!DIRECT_CHAT_COMMANDS.has(method)) throw new Error(`not a direct chat command: ${method}`)
      const r = runtime()
      const owner = r.storage.forTab(tabId)
      if (!owner) throw new Error('No chat conversation for this tab')
      const result = await r.invoke(
        parseChatInvocation({
          route: { id: owner.identity.id, epoch },
          target: 'ops',
          method,
          args,
          operationId
        })
      )
      const payload: ChatDirectWritePayload = {
        tabId,
        conversationId: owner.identity.id,
        epoch,
        method
      }
      opts.ctx.dialer.notify(ComputerNotificationMethods.event, {
        name: CHAT_DIRECT_WRITE_EVENT_NAME,
        payload
      })
      return result
    },
    watch(tabId, epoch, onEvent, onEnd) {
      const owner = instance?.storage.forTab(tabId)
      if (!owner || owner.state !== 'active' || owner.identity.epoch !== epoch) return null
      return directFanout.watch(tabId, epoch, onEvent, onEnd)
    }
  }

  return {
    request,
    direct,
    assertTaskActive(taskId: string) {
      const r = runtime()
      if (r.storage.taskLifecycle(taskId).state !== 'active')
        throw new Error('Task chat is paused or deleted')
      if (r.storage.listForTask(taskId).some((c) => c.state === 'frozen' || c.state === 'prepared'))
        throw new Error('Task chat migration is pending')
    },
    captureHook: (hook: ResolvedAgentHook) => runtime().captureHook(hook),
    async close() {
      if (closed) return
      closed = true
      directFanout.endAll()
      if (instance) await instance.close()
      localProcs?.disposeAll()
      instance = null
      localProcs = null
    },
    hasWork: () =>
      Boolean(
        instance?.transport
          .listChatSessions()
          .some((s) => s.state === 'running' || s.state === 'starting' || s.state === 'background')
      )
  }
}
