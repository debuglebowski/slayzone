import type { ResolvedAgentHook } from '@slayzone/terminal-contracts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createComputerChatRuntime, type ChatBootstrap } from '@slayzone/chat-runtime/server'
import {
  chatBootstrapSchema,
  parseChatInvocation,
  chatRouteSchema,
  chatAttachmentSchema,
  chatTransferManifestSchema
} from '@slayzone/chat-runtime/shared'
import {
  createRoutingChatBackend,
  type ComputerGatewayEvents,
  type RoutingGateway
} from '@slayzone/computer-transport/server'
import {
  TypedEventEmitter,
  ComputerNotificationMethods,
  HubToComputerMethods,
  procDataParamsSchema,
  procExitParamsSchema,
  workspaceCaptureBeginSchema,
  workspaceCaptureResultSchema,
  projectNotPlacedError
} from '@slayzone/computer-transport/shared'
import { assertPathAllowed, spawnCwd } from '../config'
import { createProcHandlers } from './proc'
import { createClaudeSessionHandlers } from './claude-session'
import { createWorkspaceChangesHandlers } from './workspace-changes'
import type { HandlerContext } from './types'
import type { ProjectPathStore } from '../project-paths'
import type { SpawnAdmission } from '../spawn-admission'

const requestSchema = z.discriminatedUnion('kind', [
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
}) {
  let closed = false
  let instance: ReturnType<typeof createComputerChatRuntime> | null = null
  let localProcs: ReturnType<typeof createProcHandlers> | null = null
  function runtime() {
    if (closed) throw new Error('Chat runtime is shutting down')
    if (instance) return instance
    const computerId = opts.computerId()
    if (!computerId) throw new Error('Computer identity is unavailable')
    const events = new TypedEventEmitter<ComputerGatewayEvents>()
    const procs = createProcHandlers(
      {
        ...opts.ctx,
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
      sessionReader: async (input) =>
        session[HubToComputerMethods.claudeSessionRead](input) as Promise<{
          found: boolean
          records: Array<Record<string, unknown>>
          omitted: number
        }>,
      transport: {
        backend,
        onStateChange: (sessionId, newState, oldState) =>
          publish('state', { sessionId, newState, oldState }),
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
    instance.transport.setAgentStateTabRecorder((tabId, state) =>
      instance?.local.metadata(tabId, 'agent-state', { state })
    )
    instance.events.on('event', (tabId, event, seq, live, at) =>
      publish('event', { tabId, event, seq, live, at })
    )
    instance.events.on('exit', (tabId, sessionId, code, signal) =>
      publish('exit', { tabId, sessionId, code, signal })
    )
    instance.events.on('threads-changed', (tabId) => publish('threads-changed', { tabId }))
    instance.queueEvents.on('queue-changed', (tabId) => publish('queue-changed', { tabId }))
    instance.queueEvents.on('queue-drained', (tabId, original) =>
      publish('queue-drained', { tabId, original })
    )
    return instance
  }
  async function request(raw: unknown): Promise<unknown> {
    const req = requestSchema.parse(raw),
      r = runtime()
    switch (req.kind) {
      case 'prompts':
        return r.prompts(req.taskId, req.agentId, req.excluded)
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
          call.args[0] = assertPathAllowed(
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
      case 'migration.activate': {
        const owner = r.storage.conversation(req.id)
        if (owner?.state === 'prepared' && r.attachments.missing(req.id).length)
          throw new Error('Migration attachments are incomplete')
        r.storage.activate(req.id, req.migrationId, req.epoch, req.hash)
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
        const records = r.storage.records(req.route.id)
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
          if (o.cwd) o.cwd = assertPathAllowed(o.cwd, opts.ctx.config.allowedRoots)
          else {
            const i = r.storage.conversation(call.route.id)?.identity
            const b = i ? r.local.get<ChatBootstrap>(i.tabId, 'settings', 'bootstrap') : null
            if (b) o.cwd = b.cwd
          }
        }
        if (['listSkills', 'listCommands', 'listAgents', 'listFiles'].includes(call.method))
          call.args[0] = assertPathAllowed(String(first), opts.ctx.config.allowedRoots)
        return r.invoke(call)
      }
      case 'inspect':
        return r.storage.conversation(req.id)
      case 'pendingMetadata':
        return r.storage
          .findRecords('settings')
          .filter((r) => r.id.startsWith('metadata:'))
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
  return {
    request,
    captureHook: (hook: ResolvedAgentHook) => runtime().captureHook(hook),
    async close() {
      if (closed) return
      closed = true
      if (instance) await instance.close()
      localProcs?.disposeAll()
      instance = null
      localProcs = null
    },
    hasWork: () =>
      Boolean(
        instance?.transport
          .listChatSessions()
          .some((s) => s.state === 'running' || s.state === 'starting')
      )
  }
}
