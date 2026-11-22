import { computerStorageWorkerEntry } from '../computer-worker-entry'
import { createComputerTimelineWorkers } from '../timeline-worker'
import { isAbsolute, join, resolve } from 'node:path'
import {
  DEFAULT_WORKTREE_BASE_PATH_TEMPLATE,
  resolveWorktreeBasePathTemplate
} from '@slayzone/worktrees/shared'
import { createComputerFaults } from '../item-faults'
import {
  chatSavedSummary,
  type AgentEvent,
  type ResolvedAgentHook
} from '@slayzone/terminal-contracts'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { chatTestRequestSchema, handleChatTesting } from './chat-testing'
import {
  openComputerChatRuntime,
  type OnlineComputerChatRuntime,
  computerRequestSchema,
  type ChatBootstrap,
  isStorageOnlyChatOwner,
  resolveChatScope
} from '@slayzone/chat-runtime/server'
import type { WirePathScope } from '@slayzone/platform/path-scope'
import { parseChatInvocation } from '@slayzone/chat-runtime/shared'
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
import {
  judgePath,
  outsideScopeJail,
  runInScopeJail,
  type ScopeJail,
  scopedSpawnCwd,
  spawnCwd
} from '../path-jail'
import { createProcHandlers, type ProcHandlerOptions } from './proc'
import { createClaudeSessionHandlers } from './claude-session'
import {
  createSessionMoveFiles,
  relocateClaudeTranscript,
  type SessionMoveFiles
} from './session-move-files'
import { createWorkspaceChangesHandlers } from './workspace-changes'
import type { HandlerContext } from './types'
import { relocatedPath } from '../project-relocation'
import { createDirectChatFanout, type DirectChatEvent } from '../direct/chat-fanout'
import { createChatRelayFilter } from '../direct/chat-relay-filter'

/** History reads a direct-link client may make (docs/direct-link.md). */
export const DIRECT_CHAT_READS = new Set([
  'getReplay',
  'getReplayPage',
  'readBlob',
  'openTimeline',
  'timelinePages',
  'toolDetail',
  'searchTimeline'
] as const)
export type DirectChatRead = typeof DIRECT_CHAT_READS extends Set<infer M> ? M : never

/**
 * Commands a direct-link client may send: they need only the computer's ownership
 * check. Everything that needs the hub's coordination (send, queue, rewind, …),
 * drafts with attachments (the hub seals their bytes) and permission / tool answers
 * (the hub refuses them while the conversation runs in the terminal) stay hub calls.
 */
export const DIRECT_CHAT_COMMANDS = new Set(['saveTabDraft', 'saveTabScroll'] as const)
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
  ): (() => void) | null | Promise<(() => void) | null>
}
/**
 * One hub's computer-only task data, as direct-link clients read it (a `task` grant).
 * The same reads the hub relays (`taskData`), answered from this computer's store.
 */
export interface DirectTaskDataService {
  read(taskId: string, request: unknown): Promise<unknown>
}
import type { ProjectPathStore } from '../project-paths'
import { createTurnGitIo } from './turn-git-io'
import { createConversationHealIo } from './conversation-heal-io'
import type { SpawnAdmission } from '../spawn-admission'

/**
 * Where a project's worktrees are made, from its folder HERE (B1): the default
 * `../<folder name>-workspaces` always, and the hub's configured `worktree_base_path`
 * template when the scope carries one (resolved against this folder; a relative one
 * is project-relative). Absolute folders only.
 */
export function projectWorktreeBases(folder: string, scope: WirePathScope): string[] {
  const templates = [DEFAULT_WORKTREE_BASE_PATH_TEMPLATE]
  if (scope.kind === 'project' && scope.worktreeBase) templates.push(scope.worktreeBase)
  const bases = templates
    .map((t) => resolveWorktreeBasePathTemplate(t, folder))
    .filter((b) => b && isAbsolute(b))
    .map((b) => resolve(b))
  return [...new Set(bases)]
}

/** A per-hub runtime. Raw subprocess output never leaves this process. */
/**
 * Requests whose reply the hub relies on as durable (S5): it handed data over and may
 * drop its own copy, or it records the change as done. Their reply waits for
 * `storage.flush()` (an off-thread WAL sync). A chat or artifact command counts when
 * it mutates (it carries an operation id); reads, `ackMetadata` (its loss only
 * repeats a delivery the receipts dedupe) and live output never wait.
 */
const DURABLE_ACK_KINDS = new Set([
  'bootstrap',
  'data.import',
  'ledger',
  'turns',
  'taskPaths',
  'task.lifecycle',
  'task.erase',
  'conversation.delete',
  'conversation.transition',
  'hook.capture',
  'migration.checkpoint',
  'migration.prepared',
  'migration.activate',
  'transfer.begin',
  'transfer.chunk',
  'transfer.finish',
  'sessionMove.export',
  'sessionMove.discard',
  'sessionMove.forget',
  'sessionMove.fileWrite',
  'attachment.put',
  'folders.delete',
  'retention.configure',
  'diagnostics.configure',
  'backup.configure'
])
export function durableAck(req: { kind: string; value?: unknown }): boolean {
  if (req.kind === 'invoke' || req.kind === 'artifact.invoke')
    return (
      typeof req.value === 'object' &&
      req.value !== null &&
      typeof (req.value as { operationId?: unknown }).operationId === 'string'
    )
  return DURABLE_ACK_KINDS.has(req.kind)
}

export function createChatRuntimeHandlers(opts: {
  ctx: HandlerContext
  stateDir: string
  workerPath?: string
  hubScope: string
  computerId: () => string | null
  getProjectPaths: () => ProjectPathStore | null
  admission?: SpawnAdmission
  /** Tests only: starts provider processes (default: `child_process.spawn`). */
  spawnProcess?: ProcHandlerOptions['spawnProcess']
  hasTaskWork?(taskId: string): boolean
  stopTask?(taskId: string, state?: 'paused' | 'deleted'): Promise<void>
}) {
  let closing: Promise<void> | null = null
  let closed = false,
    resetting = false
  const timelineWorkers = createComputerTimelineWorkers()
  let instance: OnlineComputerChatRuntime | null = null
  let opening: Promise<OnlineComputerChatRuntime> | null = null
  let generation = 0
  let moveFilesInstance: SessionMoveFiles | null = null
  /** A moved task's session files here (Claude transcripts, scrollback): see session-move-files.ts. */
  const moveFiles = (_r: OnlineComputerChatRuntime): SessionMoveFiles =>
    (moveFilesInstance ??= createSessionMoveFiles({
      stateDir: opts.stateDir,
      hubScope: opts.hubScope,
      projectFolder: async (projectId, taskId) => {
        const paths = taskId ? await (await runtime()).taskPaths.get(taskId) : null
        return (
          paths?.worktreePath ??
          paths?.baseDir ??
          opts.getProjectPaths()?.get(projectId)?.path ??
          null
        )
      },
      sessionIds: async (taskId) => (await runtime()).sessionMoves.cliSessionIds(taskId)
    }))
  let localProcs: ReturnType<typeof createProcHandlers> | null = null
  const directFanout = createDirectChatFanout()
  /** Which tabs' full events this hub wants (`relay.watch`); all until it says. */
  const relay = createChatRelayFilter()
  function runtime(): Promise<OnlineComputerChatRuntime> {
    if (closed || resetting) return Promise.reject(new Error('Chat runtime is shutting down'))
    if (instance) return Promise.resolve(instance)
    if (opening) return opening
    const epoch = generation
    const work = createRuntime(epoch)
    opening = work
    void work
      .finally(() => {
        if (opening === work) opening = null
      })
      .catch(() => undefined)
    return work
  }
  async function createRuntime(epoch: number): Promise<OnlineComputerChatRuntime> {
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
      {
        admission: opts.admission,
        spawnProcess: opts.spawnProcess,
        assertTaskActive: async (taskId) => {
          opts.ctx.assertTaskAvailable?.(taskId)
          await (await runtime()).assertTaskActive(taskId)
        },
        taskAdmission: {
          acquire: async (taskId) => {
            opts.ctx.assertTaskAvailable?.(taskId)
            return (await runtime()).taskAdmission.acquire(taskId)
          }
        }
      }
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
    const backend = createRoutingChatBackend({
      gateway,
      resolveComputerId: () => computerId,
      outputFlow: (sessionId, spawnId, paused) => procs.setOutputPaused(sessionId, spawnId, paused),
      onPhysicalExit: (sessionId, spawnId, cb) => procs.onPhysicalExit(sessionId, spawnId, cb)
    })
    const session = createClaudeSessionHandlers(opts.ctx, opts.getProjectPaths)
    const workspace = createWorkspaceChangesHandlers(opts.ctx, opts.getProjectPaths)
    function publish(type: string, data: Record<string, unknown>) {
      if (closed || resetting || generation !== epoch) return
      const tabId =
        typeof data.tabId === 'string'
          ? data.tabId
          : typeof data.sessionId === 'string'
            ? data.sessionId.split(':').slice(1).join(':')
            : null
      const owner = tabId ? instance?.publicationOwner(tabId) : null
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
    const created = await openComputerChatRuntime({
      stateDir: opts.stateDir,
      hubScope: opts.hubScope,
      workerPath: opts.workerPath ?? computerStorageWorkerEntry(),
      computerId,
      holdHistoryRead: opts.admission?.holdHistoryRead,
      hasExternalTaskWork: opts.hasTaskWork,
      log: (line) => opts.ctx.log(line),
      healIo: createConversationHealIo(opts.ctx, opts.getProjectPaths),
      turnGit: createTurnGitIo(opts.ctx),
      sessionReader: async (input) =>
        session[HubToComputerMethods.claudeSessionRead](input) as Promise<{
          found: boolean
          records: Array<Record<string, unknown>>
          omitted: number
        }>,
      transport: {
        beginTimelineProjection: timelineWorkers?.begin,
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
    if (closed || resetting || generation !== epoch) {
      await created.close()
      procs.disposeAll()
      throw new Error('Chat runtime generation changed during startup')
    }
    instance = created
    instance.transport.setAgentStateTabRecorder((tabId, state) => {
      void created.control
        .agentState(tabId, state)
        .catch((error) =>
          opts.ctx.log('chat agent-state persistence failed', { error: String(error) })
        )
    })
    instance.events.on('event', (tabId, event, seq, live, at) =>
      publish('event', { tabId, event, seq, live, at })
    )
    instance.events.on('exit', (tabId, sessionId, code, signal) =>
      publish('exit', { tabId, sessionId, code, signal })
    )
    instance.events.on('threads-changed', (tabId) => publish('threads-changed', { tabId }))
    instance.events.on('sessions-changed', (tabId) => publish('sessions-changed', { tabId }))
    instance.events.on('pinned-messages-changed', (tabId) =>
      publish('pinned-messages-changed', { tabId })
    )
    instance.queueEvents.on('queue-changed', (tabId) => publish('queue-changed', { tabId }))
    instance.queueEvents.on('queue-drained', (tabId, original) =>
      publish('queue-drained', { tabId, original })
    )
    return instance
  }
  const faults = createComputerFaults({
    runtime,
    runtimeDir: join(opts.stateDir, 'computer-runtime'),
    hubUrl: opts.ctx.config.hubUrl
  })
  /** A fresh atomic store snapshot, then current host placements; failures refuse access. */
  async function boundsOf(scope: WirePathScope) {
    if (closed || resetting) throw new Error('Chat path authority is unavailable')
    const snapshot = await (await runtime()).authority.scope(scope)
    if (closed || resetting) throw new Error('Chat path authority is unavailable')
    return resolveChatScope(
      snapshot,
      scope,
      (projectId) => opts.getProjectPaths()?.get(projectId)?.path ?? null,
      () => opts.getProjectPaths()?.list() ?? [],
      (_projectId, folder) => projectWorktreeBases(folder, scope)
    )
  }
  async function scopeJail(scope: WirePathScope): Promise<ScopeJail> {
    const bounds = await boundsOf(scope)
    return {
      label: scope.kind === 'task' ? `task ${scope.taskId}` : `project ${scope.projectId}`,
      roots: bounds.roots,
      excluded: bounds.excluded,
      foreign: bounds.foreign,
      hostReads: scope.hostReads === true
    }
  }
  /**
   * The task a chat conversation belongs to, as a path scope (§9 Phase 7c): its
   * agent starts, and its folder lists run, inside that task's own folders here.
   */
  async function conversationScope(
    r: OnlineComputerChatRuntime,
    conversationId: string
  ): Promise<WirePathScope | null> {
    const owner = await r.storage.conversation(conversationId)
    if (!owner) return null
    const bootstrap = await r.local.get<ChatBootstrap>(
      owner.identity.tabId,
      'settings',
      'bootstrap'
    )
    return { kind: 'task', taskId: owner.identity.taskId, projectId: bootstrap?.projectId ?? null }
  }
  /** `cwd` judged inside the conversation's task folders; refused without one. */
  async function judgeChatPath(
    r: OnlineComputerChatRuntime,
    conversationId: string,
    candidate: string
  ): Promise<string> {
    const scope = await conversationScope(r, conversationId)
    if (!scope) throw new Error('Chat conversation is not on this computer')
    return runInScopeJail(await scopeJail(scope), () =>
      judgePath(candidate, opts.ctx.config.allowedRoots)
    )
  }

  async function request(raw: unknown, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    options.signal?.throwIfAborted()
    const req = computerRequestSchema.parse(raw)
    if (req.kind.startsWith('test.') && process.env.PLAYWRIGHT !== '1')
      throw new Error('test-only handler unavailable')
    if (req.kind !== 'test.reset' && req.kind.startsWith('test.'))
      return handleChatTesting(await runtime(), chatTestRequestSchema.parse(req))
    if (req.kind === 'test.reset') {
      if (!process.env.PLAYWRIGHT) throw new Error('Test reset is unavailable')
      resetting = true
      generation++
      if (opening) await opening.catch(() => undefined)
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
    const r = await runtime()
    options.signal?.throwIfAborted()
    const result = await handle(req, r, options)
    // The hub hands this data over (and may drop its copy) or records the change as
    // done: the reply waits for the canonical owner's real FULL fence. Read-only
    // requests and live fragments need no additional handover fence.
    if (durableAck(req)) await r.storage.flush()
    return result
  }
  async function handle(
    req: z.infer<typeof computerRequestSchema>,
    r: OnlineComputerChatRuntime,
    options: { signal?: AbortSignal }
  ): Promise<unknown> {
    switch (req.kind) {
      case 'control':
        return r.processControl(req)
      case 'control.prepare':
      case 'control.cancel':
      case 'control.renew':
        return r.prepareControl(req)
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
        await r.captureHook(req.hook)
        return { ok: true }
      case 'inventory':
        return await r.requests.handle(req)
      case 'data.import':
        return await r.taskData.importBatch(req.value)
      case 'ledger':
        return await r.ledger.handle(req.value)
      case 'turns': {
        const value = req.value
        if (value.op !== 'record' && value.op !== 'list') return await r.turns.handle(value)
        // The task's checkout is this computer's to know (§9 Phase 7c/7d): its worktree,
        // else its project's folder here; a given path is judged against its folders.
        const { taskId, projectId } = value
        const jail = await scopeJail({ kind: 'task', taskId, projectId })
        const heldPath = await r.taskPaths.get(taskId)
        const repoPath = runInScopeJail(jail, () => {
          const own =
            value.repoPath ??
            heldPath?.worktreePath ??
            (projectId ? opts.getProjectPaths()?.get(projectId)?.path : undefined)
          return own ? judgePath(own, opts.ctx.config.allowedRoots) : null
        })
        // No checkout here: nothing to snapshot / list (skipped quietly, as on the hub).
        if (!repoPath)
          return value.op === 'record' ? { recorded: false } : { worktreePath: '', rows: [] }
        return await r.turns.handle({ ...value, repoPath })
      }
      case 'taskPaths': {
        const value = req.value
        if (value.op === 'set') {
          // The hub keeps no path (§9 Phase 7e): a path set for a task is judged HERE.
          // It is the task's DECLARED root (B3) — a folder the user chose (a custom
          // folder outside the project, one another task already uses, one inside
          // another project's folder; a worktree assigned from the Worktrees tab, as a
          // subtask shares its parent's) or the worktree just made for it — so it is
          // judged by this computer's machine bound only: inside its allowed roots, no
          // link out of them, never its own state. Reaching another task's worktree
          // through the task's scope stays refused (`scopeBounds`); declaring one is
          // the user's choice. Outside any request scope, whatever the hub sent.
          outsideScopeJail(() => {
            for (const path of [value.worktreePath, value.baseDir])
              if (path) judgePath(path, opts.ctx.config.allowedRoots)
          })
        }
        return await r.taskPaths.handle(value)
      }
      case 'taskData':
        return await r.taskData.read(req.taskId, req.request)
      case 'metadata.snapshot':
        return await r.artifacts.metadata(req.id)
      case 'artifact.invoke':
        return await r.artifacts.invoke(req.value, options)
      case 'backup.list':
        return await r.backups.list()
      case 'backup.create':
        return await r.backups.create('manual', req.id)
      case 'backup.delete':
        await r.backups.delete(req.id)
        return null
      case 'backup.restore':
        return await r.backups.restore(req.backupId, req.archiveId)
      case 'backup.settings':
        return await r.backups.settings()
      case 'storage.status':
        return await r.compaction.status()
      case 'storage.compact':
        return await r.compaction.start()
      case 'storage.cancel':
        await r.compaction.cancel()
        return null
      case 'retention.configure':
        await r.retention.configure(req.days)
        return { days: await r.retention.days() }
      case 'diagnostics.configure':
        await r.configureDiagnostics({ enabled: req.enabled, verbose: req.verbose })
        return await r.diagnosticsConfig()
      case 'backup.configure':
        await r.backups.configure(req.settings)
        return null
      case 'faults.list':
        return faults.list()
      case 'faults.retry':
        await faults.retry(req.ref)
        return { ok: true }
      case 'faults.discard':
        await faults.discard(req.ref)
        return { ok: true }
      case 'archive.list':
        return await r.backups.listArchives()
      case 'folders.inventory':
        return await r.artifacts.deletedFolderInventory(req.after)
      case 'folders.delete':
        await r.artifacts.deleteFolders(req.taskId, req.folderIds)
        return { ok: true }
      case 'archive.conversations':
        return await r.backups.conversations(req.archiveId)
      case 'archive.file': {
        const file = await r.backups.file(
          req.archiveId,
          req.conversationId,
          req.artifactId,
          req.contentHash
        )
        return { name: file.name, data: file.data.toString('base64') }
      }
      case 'archive.read':
        return await r.backups.read(req.archiveId, req.conversationId, req.afterSeq)
      case 'archive.records':
        return await r.backups.records(req.archiveId, req.conversationId, req.afterCursor)
      case 'archive.attachment':
        return {
          data: (await r.backups.attachment(req.archiveId, req.conversationId, req.ref)).toString(
            'base64'
          )
        }
      case 'archive.blob':
        return await r.backups.blob(req.archiveId, req.conversationId, req.sha256, req.offset)

      case 'task.lifecycles':
        return await r.storage.taskLifecycles()
      case 'task.lifecycle': {
        const applied = await r.applyTaskLifecycle(req.taskId, req.state, req.revision)
        if (applied.state !== 'active') await opts.stopTask?.(req.taskId, applied.state)
        return applied
      }
      case 'task.erase':
        return r.eraseTask(req.taskId, req.revision, async () => {
          await opts.stopTask?.(req.taskId, 'deleted')
          await localProcs?.stopTask(req.taskId)
        })
      case 'migration.checkpoint':
        return await r.storage.migrationCheckpoint(req.identity, req.migrationId, req.candidate)
      case 'prompts':
        return await r.prompts(req.taskId, req.agentId, req.excluded)
      case 'prompt.summaries':
        return await r.promptSummaries(
          req.taskId,
          req.all === true ? null : (req.conversationIds ?? [])
        )
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
          await r.bootstrap({
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
          // A folder list runs inside one task's own folders (§9 Phase 7c): the
          // conversation's, else the task the hub named for a chat not opened yet.
          const owner = req.route ? await r.storage.conversation(route.id) : null,
            bootstrap = owner
              ? await r.local.get<ChatBootstrap>(owner.identity.tabId, 'settings', 'bootstrap')
              : null
          const candidate = String(call.args[0] || bootstrap?.cwd || '')
          if (owner) call.args[0] = await judgeChatPath(r, route.id, candidate)
          else if (req.scope)
            call.args[0] = runInScopeJail(
              await scopeJail({
                kind: 'task',
                taskId: req.scope.taskId,
                projectId: req.scope.projectId
              }),
              () => judgePath(candidate, opts.ctx.config.allowedRoots)
            )
          else throw new Error(`${req.method} names no task; refusing to list a folder`)
        }
        return r.invoke(call)
      }

      case 'transfer.begin':
        return await r.transfers.begin(req.manifest)
      case 'transfer.chunk':
        return await r.transfers.chunk(req.id, req.offset, Buffer.from(req.data, 'base64'))
      case 'transfer.finish': {
        // A move's copy replaces this store's older one of the same chat: the tab must
        // not hold the old conversation in a live session.
        const moving = await r.transfers.manifestOf(req.id)
        if (moving?.header.move) await r.transport.removeSession(moving.header.identity.tabId)
        return await r.transfers.finish(req.id)
      }
      case 'sessionMove.export':
        return await r.sessionMoves.exportTask(req.moveId, req.taskId)
      case 'sessionMove.read':
        return {
          data: await r.sessionMoves.read(req.moveId, req.conversationId, req.offset, req.length)
        }
      case 'sessionMove.discard':
        await r.sessionMoves.discard(req.moveId)
        return { ok: true }
      case 'sessionMove.forget': {
        for (const owner of await r.storage.listForTask(req.taskId)) {
          await r.transport.removeSession(owner.identity.tabId).catch(() => undefined)
          directFanout.end(owner.identity.tabId, 'deleted')
        }
        const result = await r.requests.handle(req)
        moveFiles(r).forgetScrollback(req.taskId)
        return result
      }
      case 'sessionMove.files':
        return { files: await moveFiles(r).list(req.taskId, req.projectId) }
      case 'sessionMove.fileRead':
        return moveFiles(r).read(req.taskId, req.projectId, req.ref, req.offset, req.length)
      case 'sessionMove.fileMissing':
        return { missing: await moveFiles(r).missing(req.taskId, req.projectId, req.entries) }
      case 'sessionMove.fileWrite':
        return await moveFiles(r).write(req)
      case 'migration.verify':
        return { missing: await r.attachments.missing(req.id) }
      case 'migration.prepared':
        return await r.requests.handle(req)
      case 'migration.activate':
        return await r.requests.handle(req)
      case 'attachment.has':
        return await r.requests.handle(req)
      case 'upload.begin':
        if ((req.route === undefined) !== (req.operationId === undefined))
          throw new Error('Upload begin requires both route and operation id')
        return await r.uploads.begin(
          req.sha256,
          req.size,
          req.route ? { route: req.route, operationId: req.operationId! } : undefined
        )
      case 'upload.chunk':
        if ((req.route === undefined) !== (req.uploadId === undefined))
          throw new Error('Upload chunk requires both route and upload id')
        return await r.uploads.chunk(
          req.sha256,
          req.size,
          req.offset,
          Buffer.from(req.data, 'base64'),
          req.uploadId ? { route: req.route!, uploadId: req.uploadId } : undefined
        )
      case 'attachment.put': {
        if ((req.data === undefined) === (req.staged === undefined))
          throw new Error('Attachment put names inline data or staged bytes, exactly one')
        if (req.staged) return await r.putStagedAttachment(req, options)
        if (req.data === undefined) throw new Error('Attachment inline data is missing')
        return await r.requests.handle({ ...req, data: req.data })
      }
      case 'attachment.read':
        return await r.requests.handle(req)
      case 'bytes.read': {
        const src = req.source
        if (src.type === 'attachment')
          return r.attachments.range(src.route, src.ref, req.offset, req.length)
        if (src.type === 'archive.file')
          return r.backups.fileRange(
            src.archiveId,
            src.conversationId,
            src.artifactId,
            src.contentHash,
            req.offset,
            req.length
          )
        return r.backups.attachmentRange(
          src.archiveId,
          src.conversationId,
          src.ref,
          req.offset,
          req.length
        )
      }
      case 'inspectTab':
        return await r.storage.forTab(req.tabId)

      case 'bootstrap': {
        const value = req.value as ChatBootstrap
        // The agent starts inside its task's own folders here (§9 Phase 7c): the
        // hub's cwd is judged against them, none means the task's own folder.
        // A storage-only owner (task content, artifact store) never runs an agent:
        // it opens with no folder, and any agent start there is refused below.
        const projectId = value.projectId
        const cwd =
          !value.cwd && isStorageOnlyChatOwner(value.identity)
            ? ''
            : scopedSpawnCwd(
                await scopeJail({ kind: 'task', taskId: value.identity.taskId, projectId }),
                value.cwd || undefined,
                opts.ctx.config.allowedRoots,
                projectId ? () => projectNotPlacedError(projectId) : undefined
              )
        await r.bootstrap({ ...value, cwd })
        return { ok: true, identity: (await r.storage.conversation(value.identity.id))?.identity }
      }
      case 'invoke': {
        const call = parseChatInvocation(req.value)
        const original = call.controlToken ? structuredClone(call) : undefined
        const first = call.args[0]
        if (first && typeof first === 'object' && 'cwd' in first) {
          const o = first as { cwd: string }
          if (o.cwd) o.cwd = await judgeChatPath(r, call.route.id, o.cwd)
          else {
            const i = (await r.storage.conversation(call.route.id))?.identity
            const b = i ? await r.local.get<ChatBootstrap>(i.tabId, 'settings', 'bootstrap') : null
            if (b?.cwd) o.cwd = b.cwd
            else {
              // No folder recorded (a storage-only owner): the task's own folder
              // here, else refused — an agent never starts unconfined.
              const scope = await conversationScope(r, call.route.id)
              if (!scope) throw new Error('Chat conversation is not on this computer')
              o.cwd = scopedSpawnCwd(
                await scopeJail(scope),
                undefined,
                opts.ctx.config.allowedRoots
              )
            }
          }
        }
        if (['listSkills', 'listCommands', 'listAgents', 'listFiles'].includes(call.method))
          call.args[0] = await judgeChatPath(r, call.route.id, String(first))
        return r.invoke(call, original)
      }
      case 'inspect':
        return await r.storage.conversation(req.id)
      case 'pendingMetadata':
        return await r.local.pendingMetadata(500)
      case 'ackMetadata':
        return await r.requests.handle(req)
    }
  }
  const direct: DirectChatService = {
    async read(tabId, epoch, method, args) {
      if (!DIRECT_CHAT_READS.has(method)) throw new Error(`not a direct chat read: ${method}`)
      const r = await runtime()
      const owner = await r.storage.forTab(tabId)
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
      const r = await runtime()
      const owner = await r.storage.forTab(tabId)
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
    async watch(tabId, epoch, onEvent, onEnd) {
      const r = await runtime(),
        version = r.publicationVersion()
      const owner = await r.storage.forTab(tabId)
      if (
        closed ||
        resetting ||
        r !== instance ||
        r.publicationVersion() !== version ||
        !owner ||
        owner.state !== 'active' ||
        owner.identity.epoch !== epoch
      )
        return null
      return directFanout.watch(tabId, epoch, onEvent, onEnd)
    }
  }

  const directTaskData: DirectTaskDataService = {
    async read(taskId, request) {
      return (await runtime()).taskData.read(taskId, request)
    }
  }

  return {
    request,
    disconnected: () => instance?.cancelPreparedControls(undefined, true),
    hasFolderWork: (contains: (cwd: string) => boolean) =>
      localProcs?.hasFolderWork(contains) ?? false,
    hasTaskWork: (taskId: string) => localProcs?.hasTaskWork(taskId) ?? false,
    assertProjectIdle: async (projectId: string) => {
      const r = await runtime(),
        state = await r.control.projectState(projectId)
      for (const record of state.records) {
        if (record.owner?.state !== 'active')
          throw new Error('Wait for chat transfers to finish before relocating the project.')
        const info = r.transport.getSessionInfo((record.value as ChatBootstrap).identity.tabId)
        if (info?.pid && !info.ended)
          throw new Error('Stop running chat agents before relocating the project.')
      }
    },
    relocateProjectPaths: async (projectId: string, source: string, target: string) => {
      const r = await runtime(),
        state = await r.control.projectState(projectId)
      const remap = (path: string) => relocatedPath(path, source, target)
      for (const session of state.sessions)
        await relocateClaudeTranscript(session.conversation_id, session.cwd, remap(session.cwd))
      await r.relocateProject(projectId, source, target)
    },
    projectTaskIds: async (projectId: string) =>
      (await runtime()).control.projectTaskIds(projectId),
    direct,
    directTaskData,
    taskAdmission: {
      acquire: async (taskId: string) => {
        opts.ctx.assertTaskAvailable?.(taskId)
        return (await runtime()).taskAdmission.acquire(taskId)
      }
    },
    async moveHistoryModes(taskId: string): Promise<string[]> {
      const r = await runtime()
      const modes = ((await r.ledger.handle({
        op: 'sessionModesInScope',
        args: { taskId, tabId: null }
      })) ?? []) as string[]
      const chats = await r.storage.listForTask(taskId)
      return [...new Set([...modes, ...chats.map((c) => c.identity.mode)])]
    },
    async stopForMove(taskId: string) {
      ;(await runtime()).transport.killByTaskId(taskId)
      await localProcs?.stopTask(taskId)
    },
    async assertTaskActive(taskId: string) {
      opts.ctx.assertTaskAvailable?.(taskId)
      await (await runtime()).assertTaskActive(taskId)
    },
    captureHook: async (hook: ResolvedAgentHook) => (await runtime()).captureHook(hook),
    sessionTasks: async (conversationIds: string[]) =>
      (await runtime()).ledger.sessionTasks(conversationIds),
    worktreeTasks: async (paths: string[]) => (await runtime()).taskPaths.byWorktree(paths),
    /**
     * What a request's path scope may touch here (§9 Phase 7b): the task's or
     * project's own folders from this hub's store, other tasks' carved out.
     */
    scopeBounds: boundsOf,
    /** The jail of a request's path scope: the task's / project's own folders here. */
    scopeJail,
    /** This hub's usage-log read offsets, kept here only (robustness plan §9, hub v209). */
    usageCursors: async () => (await runtime()).usageCursors,
    close() {
      if (closing) return closing
      closed = true
      generation++
      directFanout.endAll()
      return (closing = (async () => {
        const errors: unknown[] = []
        const attempt = async (work: () => unknown) => {
          try {
            await work()
          } catch (error) {
            errors.push(error)
          }
        }
        if (opening) await opening.catch(() => undefined)
        if (instance) await attempt(() => instance!.close())
        await attempt(() => timelineWorkers?.close())
        await attempt(() => localProcs?.disposeAll())
        instance = null
        localProcs = null
        if (errors.length === 1) throw errors[0]
        if (errors.length)
          throw new AggregateError(errors, 'Chat handler cleanup failed', { cause: errors[0] })
      })())
    },
    /** Pids of this hub's chat agent processes (stall reports name only a hub's own). */
    ownedPids: (): number[] => localProcs?.ownedPids() ?? [],
    hasWork: () =>
      Boolean(
        instance?.transport
          .listChatSessions()
          .some((s) => s.state === 'running' || s.state === 'starting' || s.state === 'background')
      )
  }
}
