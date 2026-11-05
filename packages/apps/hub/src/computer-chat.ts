import { CHAT_READ_OPERATIONS, type ChatOperation } from '@slayzone/chat-runtime/shared'
import type { ChatDeps } from '@slayzone/terminal/server'
import { createHash, randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { listPromptsForTask } from '@slayzone/agent-turns/server'
import { legacySessionPromptSummaries } from '@slayzone/task/server'
import {
  defaultChatModeSettingKey,
  defaultChatModelSettingKey,
  defaultChatEffortSettingKey,
  agentHookPrompt,
  isPromptCaptureMode,
  type ResolvedAgentHook,
  terminalAgentIdForChat,
  type ChatComputerOps,
  type ChatAttachment,
  type UserContentBlock
} from '@slayzone/terminal-contracts'
import {
  createChatRecovery,
  createChatAvailability,
  chatHistoryGeneration,
  type ComputerChatInventory,
  createChatLifecycle,
  createChatFolderDeletions,
  createChatOwnershipStore,
  createChatMigration,
  createLegacyChatSource,
  legacyChatTabContentSql,
  legacyChatTaskContentSql,
  legacySessionAmbiguous,
  createHubChatRelay,
  createHubProviderConfigStore,
  isStorageOnlyChatOwner,
  terminalStorageAgentId,
  type ChatComputerRequest,
  type HubChatOwnership,
  type ChatBootstrap,
  type LegacyChatDiagnostics,
  createChatMigrationAttachmentReader
} from '@slayzone/chat-runtime/hub'
import type {
  ChatDataOps,
  ChatAttachmentReader,
  ChatTerminalState
} from '@slayzone/terminal/runtime'
import { defaultConversationRegistry } from '@slayzone/terminal/hub'

/** `quiesce` refused: the task's agents run, so its history migration waits. */
class ChatMigrationDeferredError extends Error {}

/**
 * An agent start named a provider session another task's chat owns. Two tasks must
 * never drive one transcript, so the start is refused — naming the owner, so the
 * user can continue there or start fresh here. Rare since one task per provider
 * session (agent-sessions.ts `NOT_CLAIMED_ELSEWHERE_SQL`) keeps another task's
 * session out of this task's resume target: an explicit id (a stale resume hint)
 * is what still reaches it.
 */
export class ProviderSessionOwnedElsewhereError extends Error {
  readonly code = 'provider-session-owned-elsewhere'
  constructor(
    readonly ownerTaskId: string,
    ownerTitle: string | null
  ) {
    super(
      `This session belongs to task "${ownerTitle?.trim() || ownerTaskId}". Continue it there, or start a fresh session here.`
    )
    this.name = 'ProviderSessionOwnedElsewhereError'
  }
}

/**
 * Owner states whose hub source rows are still the conversation's history: not
 * migrated ('legacy') or copied but not yet activated ('copying', 'verified').
 * An 'active' owner's history is on its computer; hub rows left by a pending
 * cleanup are already superseded.
 */
const HUB_HISTORY_STATES: ReadonlySet<HubChatOwnership['state']> = new Set([
  'legacy',
  'copying',
  'verified'
])

export function createComputerChatServices(opts: {
  db: SlayzoneDb
  diagnostics?: LegacyChatDiagnostics
  legacyData: ChatDataOps
  attachments: ChatAttachmentReader & {
    readForMigration?: ReturnType<typeof createChatMigrationAttachmentReader>
  }
  request: ChatComputerRequest
  resolveComputer(taskId: string): Promise<string | null>
  resolveAvailabilityComputer?(taskId: string): Promise<string | null>
  connected?(computerId: string): boolean
  chatRuntimeReady?(computerId: string): boolean
  defaultComputer(): Promise<string | null>
  gate?(computerId: string, taskId: string): Promise<void>
  admitComputer?(computerId: string): Promise<void>
  retentionDays?: number
  diagnosticsConfig?(): { enabled: boolean; verbose: boolean }
  hasLiveTask(taskId: string): Promise<boolean>
  beforeInvoke?(owner: HubChatOwnership, method: string, args: unknown[]): Promise<void>
  onTasksChanged?(taskId: string): void
  onState?(
    sessionId: string,
    state: ChatTerminalState,
    previous: ChatTerminalState,
    hasUserInput: boolean
  ): void | Promise<void>
  onBackgroundJobs?(sessionId: string, count: number): void | Promise<void>
}) {
  const ownership = createChatOwnershipStore(opts.db)
  const providerConfigs = createHubProviderConfigStore(opts.db)
  const folderDeletions = createChatFolderDeletions(opts.db)
  const lifecycle = createChatLifecycle({ db: opts.db, request: opts.request })
  const request = lifecycle.request
  const recovery = createChatRecovery({
    db: opts.db,
    request: opts.request,
    gate: opts.gate,
    recoverTabTransitions: (computerId, identity, transitions) =>
      relay.recoverProviderTransitions(computerId, identity, transitions)
  })
  const recovered = new Map<string, Promise<void>>()
  const recoveryFinished = new Set<string>()
  const recoveryNonce = randomUUID()
  /** Computers recovered at least once since hub start. Their first recovery is the baseline. */
  const recoveredOnce = new Set<string>()
  /** Per conversation: how many recoveries found it changed. Bumping it reloads only its chat. */
  const historyMarks = new Map<string, number>()
  const historyGeneration = (computerId: string, conversationId: string, epoch: number) =>
    chatHistoryGeneration(
      `${recoveryNonce}:${computerId}:${historyMarks.get(conversationId) ?? 0}`,
      conversationId,
      epoch
    )
  /**
   * Conversations a client may hold stale history for: the computer saved events
   * the hub did not relay without a gap, or the hub re-read their metadata. An
   * older computer reports no sequence: always changed. Clients reload these, so
   * afterwards every conversation's history counts as complete.
   */
  function changedConversations(
    inventory: readonly ComputerChatInventory[],
    restoredMetadata: ReadonlySet<string>
  ): Set<string> {
    const changed = new Set<string>()
    for (const entry of inventory) {
      if (entry.state !== 'active') continue
      const id = entry.identity.id,
        seq = entry.historySeq
      if (relay.history.behind(id, seq) || restoredMetadata.has(id)) changed.add(id)
      if (seq !== undefined) relay.history.settle(id, seq)
    }
    return changed
  }
  function invalidateRecovery(computerId: string) {
    recovered.delete(computerId)
    recoveryFinished.delete(computerId)
  }
  function recoverComputer(computerId: string, force = false) {
    if (opts.chatRuntimeReady?.(computerId) === false) {
      invalidateRecovery(computerId)
      return Promise.reject(
        new Error(
          'Computer update pending. Stop its running agents to finish the update before opening chat.'
        )
      )
    }
    if (force && recoveryFinished.has(computerId)) invalidateRecovery(computerId)
    const existing = recovered.get(computerId)
    if (existing) return existing
    // Conversations whose migration failed this pass. One damaged legacy
    // conversation stays fenced on its own (its task refuses agents and its chat
    // reports the error, retried on the next pass) instead of failing recovery
    // for every task on the computer.
    const unfinished = new Set<string>()
    let inventory: ComputerChatInventory[] = []
    let restoredMetadata: ReadonlySet<string> = new Set()
    const work = relay
      .resumeProviderTransitions(computerId)
      .then(() => recovery.reconcile(computerId))
      .then((items) => {
        inventory = items
      })
      .then(() => lifecycle.sync(computerId))
      .then(() => relay.resumeInitializations(computerId))
      .then(async () => {
        // A hub CAS can commit before the destination receives activation. Do
        // not request active metadata from that still-prepared destination.
        const owners = await opts.db.all<{ id: string }>(
          `SELECT id FROM chat_ownership o WHERE (
            (destination_computer_id=? AND state IN ('copying','verified')) OR
            (computer_id=? AND state='active' AND cleanup_pending=1)) AND NOT EXISTS(
              SELECT 1 FROM chat_unavailable_owners u WHERE u.conversation_id=o.id AND u.computer_id=o.computer_id AND u.epoch=o.epoch) ORDER BY id`,
          [computerId, computerId]
        )
        for (const owner of owners)
          await migration.ensure(owner.id, computerId).catch((error: unknown) => {
            unfinished.add(owner.id)
            console.error(
              `[chat] migration of conversation ${owner.id} to computer ${computerId} pending:`,
              error
            )
          })
      })
      .then(() => folderDeletions.recover(computerId, opts.request, opts.gate))
      .then(async () => {
        const reported = new Map(inventory.map((entry) => [entry.identity.id, entry]))
        restoredMetadata = await relay.drainMetadata(computerId, true, unfinished, reported)
      })
      .then(() => lifecycle.sync(computerId))
      .then(async () => {
        await opts.request(computerId, {
          kind: 'diagnostics.configure',
          ...(opts.diagnosticsConfig?.() ?? { enabled: true, verbose: false })
        })
        await opts.request(computerId, {
          kind: 'retention.configure',
          days: opts.retentionDays ?? 0
        })
        if (recovered.get(computerId) === work) {
          const first = !recoveredOnce.has(computerId)
          const changed = changedConversations(inventory, restoredMetadata)
          recoveredOnce.add(computerId)
          recoveryFinished.add(computerId)
          if (!first) {
            for (const id of changed) historyMarks.set(id, (historyMarks.get(id) ?? 0) + 1)
            await relay.notifyReplayRequired(computerId, changed, (id, epoch) =>
              historyGeneration(computerId, id, epoch)
            )
          }
        }
      })
      .catch((error) => {
        if (recovered.get(computerId) === work) invalidateRecovery(computerId)
        throw error
      })
    recovered.set(computerId, work)
    return work
  }
  async function bootstrap(owner: HubChatOwnership): Promise<ChatBootstrap> {
    const task = await opts.db.get<{ project_id: string | null; worktree_path: string | null }>(
      'SELECT project_id,worktree_path FROM tasks WHERE id=?',
      [owner.taskId]
    )
    if (!task) throw new Error('Chat task no longer exists')
    if (isStorageOnlyChatOwner(owner))
      return {
        identity: {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch:
            owner.epoch +
            (owner.tabId.startsWith('task-content:') && owner.state !== 'active' ? 1 : 0)
        },
        projectId: null,
        cwd: '',
        providerConfig: {},
        defaultFlags: null,
        env: {},
        revision: (await ownership.get(owner.id))
          ? await ownership.settingsRevision(
              owner.id,
              owner.tabId.startsWith('task-content:') ? 'task-content-v1' : 'artifact-store-v1'
            )
          : 0
      }
    const computerId = owner.destinationComputerId ?? owner.computerId
    if (!computerId) throw new Error('Chat computer is unassigned')
    const terminalAgentId = terminalStorageAgentId(owner.mode)
    const projectRoot = task.project_id
      ? await opts.legacyData.getProjectRoot(task.project_id, computerId)
      : null
    const values = {
      identity: {
        id: owner.id,
        taskId: owner.taskId,
        tabId: owner.tabId,
        mode: owner.mode,
        epoch: owner.epoch + (owner.state === 'active' ? 0 : 1)
      },
      projectId: task.project_id,
      cwd: task.worktree_path ?? projectRoot ?? '',
      providerConfig: await opts.legacyData.readProviderConfig(owner.taskId, owner.mode),
      settings: Object.fromEntries(
        await Promise.all(
          ['claude-chat', 'codex-chat']
            .flatMap((mode) => [
              defaultChatModeSettingKey(mode),
              defaultChatModelSettingKey(mode),
              defaultChatEffortSettingKey(mode)
            ])
            .map(async (key) => [key, await opts.legacyData.readSetting(key)])
        )
      ),
      terminalProviderConfig: await opts.legacyData.readProviderConfig(
        owner.taskId,
        terminalAgentId
      ),
      defaultFlags: await opts.legacyData.getModeDefaultFlags(owner.mode),
      env: await opts.legacyData.buildMcpEnv(owner.taskId, owner.mode, computerId),
      deletedConversations: await opts.db.all<{ mode: string; conversationId: string }>(
        'SELECT mode,conversation_id AS conversationId FROM session_deletions WHERE task_id=?',
        [owner.taskId]
      ),
      honoredSessions: await opts.db.all<{ mode: string; conversationId: string }>(
        "SELECT DISTINCT mode,conversation_id AS conversationId FROM agent_sessions WHERE task_id=? AND mode IN (?,?) AND conversation_id IS NOT NULL AND origin NOT IN ('foreign-observed','pending-spawn')",
        [owner.taskId, owner.mode, terminalAgentId]
      )
    }
    // Capture values and their authority revision together after asynchronous
    // environment/settings work. An old captured value cannot acquire a newer
    // revision after a concurrent edit has already reached the computer.
    const provider = await providerConfigs.snapshot(owner.taskId, owner.mode)
    const terminal = await providerConfigs.snapshot(owner.taskId, terminalAgentId)
    values.providerConfig = provider.value
    values.terminalProviderConfig = terminal.value
    const hash = createHash('sha256').update(JSON.stringify(values)).digest('hex')
    return {
      ...values,
      providerConfigRevision: provider.revision,
      terminalProviderConfigRevision: terminal.revision,
      revision: (await ownership.get(owner.id))
        ? await ownership.settingsRevision(owner.id, hash)
        : 0
    }
  }
  /** Computer a legacy owner's provider session ran on. One definition for the
   * migration, its session election, and the terminal-resume ambiguity fence:
   * if they disagreed, a session could be elected in one and fenced in another. */
  // Where a legacy (hub-era) tab's agent ran: v196's record, not the legacy table.
  const sessionComputer = async (owner: HubChatOwnership) => {
    const recorded = await opts.db.get<{ computer_id: string }>(
      'SELECT computer_id FROM chat_legacy_tab_computers WHERE tab_id=?',
      [owner.tabId]
    )
    return recorded?.computer_id ?? opts.resolveComputer(owner.taskId)
  }
  const source = createLegacyChatSource({
    diagnostics: opts.diagnostics,
    freezeMetadata: (owner, migrationId, candidate) =>
      request(owner.destinationComputerId!, {
        kind: 'migration.checkpoint',
        identity: {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch: owner.epoch
        },
        migrationId,
        ...(candidate ? { candidate } : {})
      }) as Promise<import('@slayzone/chat-runtime/shared').ChatRecord[] | null>,
    db: opts.db,
    bootstrap: async (owner) => ({ ...(await bootstrap(owner)), env: {}, revision: 0 }),
    readAttachment: (_owner, ref) => opts.attachments.read(ref),
    readPinnedAttachment: opts.attachments.readForMigration,
    collectReleasedAttachments: opts.attachments.readForMigration?.collectGarbage,
    resolveSessionComputer: sessionComputer,
    quiesce: async (owner) => {
      if (await opts.hasLiveTask(owner.taskId))
        throw new ChatMigrationDeferredError(
          'Chat migration waits for this task’s agents to stop. Stop agents, then reopen chat.'
        )
    }
  })
  async function sealAttachments(owner: HubChatOwnership, method: string, args: unknown[]) {
    const route = { id: owner.id, epoch: owner.epoch },
      pc = owner.computerId!
    async function seal(ref: ChatAttachment): Promise<ChatAttachment> {
      if (ref.contentHash) {
        const existing = (await request(pc, { kind: 'attachment.has', route, ref })) as {
          present: boolean
        }
        if (existing.present) return ref
      }
      const localArtifact = await opts.db.get<{ conversation_id: string }>(
        'SELECT conversation_id FROM chat_artifact_locations WHERE artifact_id=?',
        [ref.artifactId]
      )
      if (localArtifact) {
        const original = await ownership.get(localArtifact.conversation_id)
        if (!original || original.taskId !== owner.taskId || original.computerId !== pc)
          throw new Error('Chat file belongs to another computer')
        return request(pc, {
          kind: 'artifact.invoke',
          value: { route, method: 'seal', args: [ref], operationId: randomUUID() }
        }) as Promise<ChatAttachment>
      }
      const artifact = (await opts.legacyData.attachments.artifacts([ref.artifactId])).get(
        ref.artifactId
      )
      if (!artifact || artifact.taskId !== owner.taskId)
        throw new Error('Attachment does not belong to this task')
      const hash = ref.contentHash ?? artifact.contentHash
      if (!hash || !(await opts.legacyData.attachments.hasVersion(ref.artifactId, hash)))
        throw new Error('Attachment version is missing')
      const pinned = { ...ref, contentHash: hash },
        bytes = await opts.attachments.read(pinned)
      return request(pc, {
        kind: 'attachment.put',
        route,
        ref: pinned,
        data: Buffer.from(bytes).toString('base64')
      }) as Promise<ChatAttachment>
    }
    async function content(blocks: UserContentBlock[] | undefined) {
      if (blocks)
        for (const b of blocks) if (b.type === 'attachment') b.attachment = await seal(b.attachment)
    }
    if (method === 'send') await content((args[1] as { content: UserContentBlock[] }).content)
    if (method === 'push')
      await content((args[3] as { content?: UserContentBlock[] } | undefined)?.content)
    if (method === 'update') await content((args[1] as { content: UserContentBlock[] }).content)
    if (method === 'saveTabDraft') {
      const draft = args[1] as { attachments: ChatAttachment[] }
      for (let i = 0; i < draft.attachments.length; i++)
        draft.attachments[i] = await seal(draft.attachments[i])
    }
  }
  const migration = createChatMigration({ ownership, source, request })
  /**
   * Is the hub still the source of this task's prompt history? Prompts and
   * task-wide content migrate with the task's `chat_legacy_task_authority`
   * owner; until that owner activates, its `agent_prompts` rows are the only
   * copy. Without an authority owner the task has no legacy prompt content.
   */
  async function hubHoldsTaskHistory(taskId: string) {
    const authority = await opts.db.get<{ conversation_id: string }>(
      'SELECT conversation_id FROM chat_legacy_task_authority WHERE task_id=?',
      [taskId]
    )
    if (!authority) return true
    const owner = await ownership.get(authority.conversation_id)
    return !!owner && HUB_HISTORY_STATES.has(owner.state)
  }
  /**
   * History reads of a task whose migration is deferred (its agents run, often
   * for days after an upgrade restarts them) serve the hub's legacy rows
   * read-only instead of failing. Migration itself is unchanged: every read
   * still tries it first, and once the task's history is activated on its
   * computer, reads go there. Never both sources at once: when the task's
   * prompts already moved but another conversation still waits, the deferral
   * error stands.
   */
  async function readHistory<T>(
    taskId: string,
    computer: () => Promise<T>,
    hub: () => Promise<T>
  ): Promise<T> {
    try {
      return await computer()
    } catch (error) {
      if (!(error instanceof ChatMigrationDeferredError) || !(await hubHoldsTaskHistory(taskId)))
        throw error
      return hub()
    }
  }
  async function computerPromptSummaries(taskId: string, conversationIds: string[]) {
    const owners = await relay.ensurePromptTask(taskId)
    type Summary = { conversationId: string; count: number; firstPrompt: string; firstAt: number }
    const result = new Map<string, Summary>()
    for (const computerId of new Set(owners.map((o) => o.computerId!))) {
      await opts.gate?.(computerId, taskId)
      for (let offset = 0; offset < conversationIds.length; offset += 500) {
        const summaries = (await request(computerId, {
          kind: 'prompt.summaries',
          taskId,
          conversationIds: conversationIds.slice(offset, offset + 500)
        })) as Summary[]
        for (const summary of summaries) {
          const prior = result.get(summary.conversationId)
          if (!prior) result.set(summary.conversationId, summary)
          else
            result.set(summary.conversationId, {
              ...(prior.firstAt <= summary.firstAt ? prior : summary),
              count: prior.count + summary.count
            })
        }
      }
    }
    return [...result.values()]
  }
  async function computerPrompts(taskId: string, agentId?: string) {
    const owners = await relay.ensurePromptTask(taskId)
    const excluded = (
      await opts.db.all<{ mode: string; conversation_id: string }>(
        'SELECT mode,conversation_id FROM session_deletions WHERE task_id=?',
        [taskId]
      )
    ).map((r) => ({ mode: r.mode, conversationId: r.conversation_id }))
    const result = new Map<
      string,
      {
        id: string
        task_id: string
        agent_id: string
        cli_session_id: string | null
        text: string
        created_at: number
      }
    >()
    for (const computerId of new Set(owners.map((o) => o.computerId!))) {
      await opts.gate?.(computerId, taskId)
      const prompts = (await request(computerId, {
        kind: 'prompts',
        taskId,
        agentId,
        excluded
      })) as Array<{
        id: string
        task_id: string
        agent_id: string
        cli_session_id: string | null
        text: string
        created_at: number
      }>
      for (const prompt of prompts) result.set(prompt.id, prompt)
    }
    return [...result.values()].sort(
      (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)
    )
  }
  const relay = createHubChatRelay({
    ...opts,
    recordConversation: (input) => opts.legacyData.recordConversation(input),
    request,
    stopRequest: opts.request,
    ownership,
    hasLegacyTaskContent: async (taskId) =>
      opts.diagnostics?.hasTask
        ? opts.diagnostics.hasTask(taskId)
        : ((await opts.diagnostics?.tasks()) ?? []).includes(taskId),
    resolveMigrationComputer: sessionComputer,
    recoverComputer,
    bootstrap,
    migrate: migration.ensure,
    quiesceProvider: async (owner) => {
      for (const mode of [owner.mode, terminalStorageAgentId(owner.mode)]) {
        const config = await opts.legacyData.readProviderConfig(owner.taskId, mode)
        for (const session of [config.conversationId, config.chatConversationId])
          if (
            session &&
            defaultConversationRegistry.isConversationLive('terminal', owner.taskId, session)
          )
            await defaultConversationRegistry.releaseConversation('terminal', owner.taskId, session)
      }
    },
    beforeInvoke: async (owner, method, args) => {
      await sealAttachments(owner, method, args)
      if (
        CHAT_READ_OPERATIONS.has(method as ChatOperation) ||
        ['hydrate', 'kill', 'remove'].includes(method)
      ) {
        await opts.beforeInvoke?.(owner, method, args)
        return
      }
      const first = args[0] as { conversationId?: string } | undefined
      const native = method === 'switchConversation' ? first?.conversationId : undefined
      const config = await opts.legacyData.readProviderConfig(owner.taskId, owner.mode)
      const terminalAgentId = terminalAgentIdForChat(owner.mode)
      const terminal = terminalAgentId
        ? await opts.legacyData.readProviderConfig(owner.taskId, terminalAgentId)
        : null
      const session =
        native ??
        (['continueInChat', 'takeOver'].includes(method)
          ? terminal?.conversationId
          : config.chatConversationId)
      if (session) {
        const original = await ownership.forProviderSession(session, owner.mode)
        if (original && original.computerId !== owner.computerId)
          throw new Error(
            'This provider session belongs to another computer. Open its original chat to continue.'
          )
        if (defaultConversationRegistry.isConversationLive('terminal', owner.taskId, session)) {
          if (['continueInChat', 'takeOver', 'switchConversation'].includes(method))
            await defaultConversationRegistry.releaseConversation('terminal', owner.taskId, session)
          else if (
            ![
              'continueInTerminal',
              'getInfo',
              'getReplay',
              'openTimeline',
              'timelinePages',
              'searchTimeline',
              'getTabState',
              'saveTabDraft',
              'saveTabScroll',
              'listThreads'
            ].includes(method)
          ) {
            const context = await bootstrap(owner)
            await request(owner.computerId!, {
              kind: 'invoke',
              value: {
                route: { id: owner.id, epoch: owner.epoch },
                target: 'ops',
                method: 'refuseStart',
                operationId: randomUUID(),
                args: [
                  { tabId: owner.tabId, taskId: owner.taskId, mode: owner.mode, cwd: context.cwd }
                ]
              }
            })
            throw new Error(
              'This conversation is running in the terminal. Continue in chat to stop it there first.'
            )
          }
        }
      }
      await opts.beforeInvoke?.(owner, method, args)
    }
  })
  async function computerRequest(computerId: string, body: unknown) {
    if (!opts.admitComputer) throw new Error('Computer backup access is not configured')
    await opts.admitComputer(computerId)
    await recoverComputer(computerId)
    return request(computerId, body)
  }
  const computers: ChatComputerOps = {
    listBackups: (pc) =>
      computerRequest(pc, { kind: 'backup.list' }) as ReturnType<ChatComputerOps['listBackups']>,
    createBackup: (pc, id) =>
      computerRequest(pc, { kind: 'backup.create', id }) as ReturnType<
        ChatComputerOps['createBackup']
      >,
    deleteBackup: async (pc, id) => {
      await computerRequest(pc, { kind: 'backup.delete', id })
    },
    restoreBackup: (pc, backupId, archiveId) =>
      computerRequest(pc, { kind: 'backup.restore', backupId, archiveId }) as ReturnType<
        ChatComputerOps['restoreBackup']
      >,
    backupSettings: (pc) =>
      computerRequest(pc, { kind: 'backup.settings' }) as ReturnType<
        ChatComputerOps['backupSettings']
      >,
    configureBackups: async (pc, settings) => {
      await computerRequest(pc, { kind: 'backup.configure', settings })
    },
    listArchives: (pc) =>
      computerRequest(pc, { kind: 'archive.list' }) as ReturnType<ChatComputerOps['listArchives']>,
    archiveConversations: (pc, archiveId) =>
      computerRequest(pc, { kind: 'archive.conversations', archiveId }) as ReturnType<
        ChatComputerOps['archiveConversations']
      >,
    archiveRead: (pc, archiveId, conversationId, afterSeq) =>
      computerRequest(pc, {
        kind: 'archive.read',
        archiveId,
        conversationId,
        afterSeq
      }) as ReturnType<ChatComputerOps['archiveRead']>,
    archiveRecords: (pc, archiveId, conversationId, afterCursor) =>
      computerRequest(pc, {
        kind: 'archive.records',
        archiveId,
        conversationId,
        afterCursor
      }) as ReturnType<ChatComputerOps['archiveRecords']>,
    archiveAttachment: (pc, archiveId, conversationId, ref) =>
      computerRequest(pc, {
        kind: 'archive.attachment',
        archiveId,
        conversationId,
        ref
      }) as ReturnType<ChatComputerOps['archiveAttachment']>,
    archiveFile: (pc, archiveId, conversationId, artifactId, contentHash) =>
      computerRequest(pc, {
        kind: 'archive.file',
        archiveId,
        conversationId,
        artifactId,
        contentHash
      }) as ReturnType<ChatComputerOps['archiveFile']>
  }
  return {
    testing: {
      async seedEvents(tabId, fromSeq, events) {
        if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
        const owner = await relay.ensureTab(tabId)
        for (const event of events)
          if (event.kind === 'user-message' && Array.isArray(event.content))
            await sealAttachments(owner, 'send', [tabId, event])
        await request(owner.computerId!, {
          kind: 'test.seedEvents',
          route: { id: owner.id, epoch: owner.epoch },
          fromSeq,
          events
        })
      },
      async readEvents(tabId, afterSeq, limit) {
        if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
        const owner = await relay.ensureTab(tabId)
        return request(owner.computerId!, {
          kind: 'test.readEvents',
          route: { id: owner.id, epoch: owner.epoch },
          afterSeq,
          limit
        }) as ReturnType<NonNullable<ChatDeps['testing']>['readEvents']>
      },
      async projection(tabId, action) {
        if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
        const owner = await relay.ensureTab(tabId)
        return request(owner.computerId!, {
          kind: 'test.projection',
          route: { id: owner.id, epoch: owner.epoch },
          action
        }) as ReturnType<NonNullable<ChatDeps['testing']>['projection']>
      },
      async seedPrompts(taskId, prompts) {
        if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
        const pc = await opts.resolveComputer(taskId),
          owners = await relay.ensurePromptTask(taskId),
          owner = owners.find((o) => o.computerId === pc)
        if (!owner) throw new Error('Test prompt storage is unavailable')
        await opts.gate?.(pc!, taskId)
        await request(pc!, {
          kind: 'test.seedPrompts',
          route: { id: owner.id, epoch: owner.epoch },
          prompts
        })
      }
    } satisfies NonNullable<ChatDeps['testing']>,
    computers,
    availability: createChatAvailability({
      historyGeneration,
      db: opts.db,
      ownership,
      resolveComputer: opts.resolveAvailabilityComputer ?? opts.resolveComputer,
      connected: opts.connected ?? (() => false),
      chatRuntimeReady: opts.chatRuntimeReady,
      hasLiveTask: opts.hasLiveTask,
      gate: opts.gate
    }),
    async migrateIdleComputer(computerId: string) {
      await recoverComputer(computerId)
      const tasks = new Set(
        (
          await opts.db.all<{ task_id: string }>(
            `SELECT DISTINCT t.task_id FROM terminal_tabs t LEFT JOIN chat_tab_bindings b ON b.tab_id=t.id LEFT JOIN chat_ownership o ON o.id=b.conversation_id
              WHERE (t.mode IN ('claude-chat','codex-chat') OR ${legacyChatTabContentSql()})
              AND (o.id IS NULL OR o.state IN ('legacy','copying','verified') OR o.cleanup_pending=1)
              UNION SELECT task.id AS task_id FROM tasks task WHERE ${legacyChatTaskContentSql()}`
          )
        ).map((t) => t.task_id)
      )
      for (const task of (await opts.diagnostics?.tasks()) ?? []) {
        const deleted = await opts.db.get(
          "SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted'",
          [task]
        )
        if (deleted && opts.diagnostics) {
          await opts.diagnostics.cleanup(task, await opts.diagnostics.freeze(task))
        } else tasks.add(task)
      }
      for (const taskId of tasks) {
        if (await opts.hasLiveTask(taskId)) continue
        try {
          const owners = await ownership.forTask(taskId)
          const tab = await opts.db.get<{ id: string }>(
            `SELECT t.id FROM terminal_tabs t LEFT JOIN chat_tab_bindings b ON b.tab_id=t.id LEFT JOIN chat_ownership o ON o.id=b.conversation_id WHERE t.task_id=?
              AND (t.mode IN ('claude-chat','codex-chat') OR ${legacyChatTabContentSql()})
              AND (o.id IS NULL OR o.state IN ('legacy','copying','verified') OR o.cleanup_pending=1) ORDER BY t.created_at,t.id LIMIT 1`,
            [taskId]
          )
          const recorded = tab
            ? await opts.db.get<{ computer_id: string }>(
                'SELECT computer_id FROM chat_legacy_tab_computers WHERE tab_id=?',
                [tab.id]
              )
            : null
          const pc =
            owners.find((o) => o.state !== 'deleted' && o.destinationComputerId)
              ?.destinationComputerId ??
            recorded?.computer_id ??
            (await opts.resolveComputer(taskId))
          if (pc !== computerId) continue
          if (tab) await relay.ensureTab(tab.id)
          else if (await opts.db.get('SELECT 1 FROM tasks WHERE id=?', [taskId]))
            await relay.ensurePromptTask(taskId)
        } catch {
          /* A disconnected, active or unplaced task remains fenced and retries later. */
        }
      }
    },
    async captureHook(hook: ResolvedAgentHook, reportedComputer?: string | null) {
      if (!hook.taskId || !agentHookPrompt(hook) || !isPromptCaptureMode(hook.agentId)) return
      const owner = hook.sessionId
        ? await ownership.forProviderSession(hook.sessionId, hook.mode)
        : null
      const pc = reportedComputer ?? owner?.computerId ?? (await opts.resolveComputer(hook.taskId))
      if (!pc) throw new Error('Prompt storage computer is unavailable')
      await opts.gate?.(pc, hook.taskId)
      await recoverComputer(pc)
      await lifecycle.track(hook.taskId, pc)
      await request(pc, { kind: 'hook.capture', hook })
    },
    async stopTask(taskId: string) {
      await Promise.all(
        (await ownership.forTask(taskId))
          .filter(
            (o) => o.state === 'active' && o.computerId && !o.tabId.startsWith('artifact-store:')
          )
          .map(async (owner) => {
            if (await ownership.unavailable(owner.id)) return
            await opts.gate?.(owner.computerId!, owner.taskId)
            const stop =
              opts.chatRuntimeReady?.(owner.computerId!) === false ? opts.request : request
            await stop(owner.computerId!, {
              kind: 'invoke',
              value: {
                route: { id: owner.id, epoch: owner.epoch },
                target: 'ops',
                method: 'kill',
                args: [owner.tabId],
                operationId: randomUUID()
              }
            })
          })
      )
    },
    async resetForTest() {
      recovered.clear()
      recoveryFinished.clear()
      await relay.resetCaches()
    },
    async artifactOwner(taskId: string, preferredComputer?: string) {
      const pc = preferredComputer ?? (await opts.resolveComputer(taskId))
      if (!pc) throw new Error('Artifact computer is unavailable')
      await opts.gate?.(pc, taskId)
      await recoverComputer(pc)
      const existing = (await ownership.forTask(taskId)).find(
        (o) => o.state === 'active' && o.computerId === pc && o.tabId.startsWith('artifact-store:')
      )
      if (existing) {
        const unavailable = await ownership.unavailable(existing.id)
        if (unavailable) throw new Error(unavailable.reason)
        return existing
      }
      const identity = {
        id: `artifact-store:${createHash('sha256')
          .update(JSON.stringify([taskId, pc]))
          .digest('hex')}`,
        taskId,
        tabId: `artifact-store:${createHash('sha256')
          .update(JSON.stringify([taskId, pc]))
          .digest('hex')}`,
        mode: 'claude-chat',
        epoch: 1,
        computerId: pc
      }
      await lifecycle.track(taskId, pc)
      return relay.initializeOwner(await ownership.reserveBootstrap(identity))
    },
    recoverComputer,
    ownership,
    invalidateRecovery,
    folderDeletions,
    migration,
    relay,
    lifecycle,
    async resolvePtyComputer(
      taskId: string,
      context?: { mode?: string; conversationId?: string | null }
    ) {
      // Storage-only owners never fence agent starts (see the migration fence
      // below): an agent neither resumes from nor writes into their history, so
      // their missing history surfaces where it is read, not here.
      const assertTaskHistory = async () => {
        for (const o of await ownership.forTask(taskId)) {
          if (o.state !== 'active' || isStorageOnlyChatOwner(o)) continue
          const missing = await ownership.unavailable(o.id)
          if (missing) throw new Error(missing.reason)
        }
      }
      const lifecycleState = await opts.db.get<{ state: string }>(
        'SELECT state FROM chat_task_lifecycle WHERE task_id=?',
        [taskId]
      )
      if (lifecycleState && lifecycleState.state !== 'active')
        throw new Error('This task is paused or deleted. Restore it before starting an agent.')
      // A storage-only owner has no tab to reopen and no provider session for an
      // agent to resume: its pending migration fences nothing an agent touches
      // (terminal prompts land in the computer's own store, v187 triggers refuse
      // legacy writes once a migration starts, cleanup removes only copied rows)
      // and retries when the task is idle. Chat-tab owners fence.
      const chatOwners = (await ownership.forTask(taskId)).filter((o) => !isStorageOnlyChatOwner(o))
      const chatLabel = async (o: HubChatOwnership) =>
        (
          await opts.db.get<{ label: string | null }>(
            'SELECT label FROM terminal_tabs WHERE id=? AND task_id=?',
            [o.tabId, taskId]
          )
        )?.label?.trim() || null
      // Copy/verify, or an active owner whose legacy cleanup is still owed:
      // opening that chat runs the migration to completion.
      const migrating = chatOwners.find(
        (o) =>
          o.state === 'copying' ||
          o.state === 'verified' ||
          (o.state !== 'deleted' && o.cleanupPending)
      )
      if (migrating) {
        const label = await chatLabel(migrating)
        throw new Error(
          label
            ? `Chat history migration is pending for "${label}". Open that chat to finish it, then start this agent.`
            : 'Chat history migration is pending for a chat in this task. Open that chat to finish it, then start this agent.'
        )
      }
      // A deleted chat stays pending until every computer that held it
      // acknowledges the deletion, which happens when that computer connects.
      const deleting = chatOwners.find((o) => o.state === 'deleted' && o.cleanupPending)
      if (deleting) {
        const label = await chatLabel(deleting)
        throw new Error(
          label
            ? `Deleted chat "${label}" is still being removed from its computer. Reconnect that computer, then start this agent.`
            : 'A deleted chat is still being removed from its computer. Reconnect that computer, then start this agent.'
        )
      }
      const native =
        context?.conversationId ??
        (context?.mode
          ? await opts.legacyData.getCurrentConversationId(taskId, context.mode)
          : null)
      const owner =
        native && context?.mode ? await ownership.forProviderSession(native, context.mode) : null
      if (
        !owner &&
        native &&
        context?.mode &&
        (await legacySessionAmbiguous(opts.db, taskId, context.mode, native, sessionComputer))
      )
        throw new Error(
          'Original computer for this historical provider session is ambiguous. Open its original chat before continuing.'
        )
      if (owner) {
        await recoverComputer(owner.computerId!)
        await assertTaskHistory()
        await lifecycle.sync(owner.computerId!)
        if (owner.taskId !== taskId) {
          const ownerTask = await opts.db.get<{ title: string | null }>(
            'SELECT title FROM tasks WHERE id=?',
            [owner.taskId]
          )
          throw new ProviderSessionOwnedElsewhereError(owner.taskId, ownerTask?.title ?? null)
        }
        if (owner.state !== 'active' || !owner.computerId)
          throw new Error('Provider session ownership is unavailable')
        await opts.gate?.(owner.computerId, taskId)
        return owner.computerId
      }
      const computerId = await opts.resolveComputer(taskId)
      if (computerId) {
        // Chat recovery guards this task's own chat history on the computer. A
        // task with none there must not inherit another conversation's (or a
        // broken chat store's) recovery failure: native agents and shells start.
        const ownsChat = async () =>
          !!(await opts.db.get(
            "SELECT 1 FROM chat_ownership WHERE task_id=? AND state<>'deleted' AND (computer_id=? OR destination_computer_id=?) LIMIT 1",
            [taskId, computerId, computerId]
          ))
        await recoverComputer(computerId).catch(async (error: unknown) => {
          if (await ownsChat()) throw error
        })
        await assertTaskHistory()
        await lifecycle.track(taskId, computerId)
        // Same split for lifecycle: the full sync also delivers chat-store state
        // (reactivation, conversation/folder deletions). Without chat there, only
        // the pause/delete fence that stops native work is required.
        await lifecycle.sync(computerId).catch(async (error: unknown) => {
          if (await ownsChat()) throw error
          await lifecycle.syncNative(computerId)
        })
      }
      return computerId
    },
    async promptSummaries(
      taskId: string,
      conversationIds: string[]
    ): Promise<Array<{ conversationId: string; count: number; firstPrompt: string }>> {
      if (!conversationIds.length) return []
      return readHistory(
        taskId,
        () => computerPromptSummaries(taskId, conversationIds),
        () =>
          legacySessionPromptSummaries(opts.db, taskId, conversationIds, { codexChatEvents: true })
      )
    },
    async prompts(taskId: string, agentId?: string) {
      return readHistory(
        taskId,
        () => computerPrompts(taskId, agentId),
        () => listPromptsForTask(opts.db, taskId, agentId)
      )
    }
  }
}
