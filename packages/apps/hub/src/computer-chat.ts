import { CHAT_READ_OPERATIONS, type ChatOperation } from '@slayzone/chat-runtime/shared'
import type { ChatDeps } from '@slayzone/terminal/server'
import { createHash, randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { legacyChatTables } from '@slayzone/platform/legacy-chat-tables'
import {
  classifyFault,
  createAsyncFaultLedger,
  forEachIsolated,
  toError
} from '@slayzone/platform/isolation'
import { AgentHistoryOfflineError } from '@slayzone/agent-turns/server'
import { legacyCodexChatPromptSummaries } from '@slayzone/task/server'
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
  applyComputerRetirements,
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
  isStorageOnlyChatOwner,
  terminalStorageAgentId,
  type ChatComputerRequest,
  type HubChatOwnership,
  type ChatBootstrap,
  type LegacyChatDiagnostics,
  createChatMigrationAttachmentReader,
  isolateItem,
  isComputerUnreachable,
  checkHubChatConsistency
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
 * An agent start named a provider session, and a computer that may hold it (the
 * computer of one of the task's chats, or the one the task resolves to) cannot be
 * reached while no reachable computer holds it. Work waits for its computer
 * (robustness plan decisions): starting it elsewhere would silently fork the
 * session or start fresh. Refused, naming the offline computer(s).
 */
export class ProviderSessionHolderOfflineError extends Error {
  readonly code = 'provider-session-holder-offline'
  constructor(readonly computerNames: string[]) {
    const names = computerNames.map((n) => `"${n}"`).join(', ')
    super(
      `The computer holding this session (${names}) is offline. Reconnect it to continue the session, or start a fresh session.`
    )
    this.name = 'ProviderSessionHolderOfflineError'
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
  /**
   * Deliver to `computerId` whatever the hub still holds of the task (the computer
   * data handoff) before a relayed history read there — as the direct link's task
   * grant does — so a read right after boot never misses rows still staged here.
   */
  flushTask?(taskId: string, computerId: string): Promise<void>
  admitComputer?(computerId: string): Promise<void>
  retentionDays?: number
  /** A reserved provider switch was superseded: record a diagnostics event. */
  onProviderTransitionSuperseded?(info: {
    id: string
    conversationId: string
    taskId: string
    reason: string
  }): void
  diagnosticsConfig?(): { enabled: boolean; verbose: boolean }
  hasLiveTask(taskId: string): Promise<boolean>
  beforeInvoke?(owner: HubChatOwnership, method: string, args: unknown[]): Promise<void>
  onTasksChanged?(taskId: string): void
  /** A task's sessions changed on its computer (its session ledger, §9). */
  onSessionsChanged?(taskId: string): void
  onState?(
    sessionId: string,
    state: ChatTerminalState,
    previous: ChatTerminalState,
    hasUserInput: boolean
  ): void | Promise<void>
  onBackgroundJobs?(sessionId: string, count: number): void | Promise<void>
}) {
  const ownership = createChatOwnershipStore(opts.db)
  const folderDeletions = createChatFolderDeletions(opts.db)
  const lifecycle = createChatLifecycle({ db: opts.db, request: opts.request })
  const request = lifecycle.request
  /**
   * Conversations the last pass on their computer could not reconcile, and why.
   * Each is fenced on its own: its chat refuses with the error (opening it again
   * re-runs recovery), its task refuses agents, and its metadata is not re-read.
   * Every other conversation on the computer keeps working. A new recovery pass
   * of the computer starts with none.
   */
  const fences = new Map<string, { computerId: string; error: Error }>()
  const fence = (computerId: string, conversationId: string | null, error: Error) => {
    if (conversationId)
      fences.set(conversationId, {
        computerId,
        error: new Error(`This chat could not be recovered: ${error.message}`, { cause: error })
      })
  }
  const conversationFence = (id: string) => fences.get(id)?.error
  /**
   * The owner check, plus the one task-level fence: a task whose paused/deleted
   * state the last lifecycle pass could not deliver to this computer.
   */
  const assertTaskDelivered = (computerId: string, taskId: string, stopsOnly = false) => {
    const failure = lifecycle.taskFailure(computerId, taskId, stopsOnly)
    if (failure)
      throw new Error(
        `This task's state could not be delivered to its computer: ${failure.message}`,
        {
          cause: failure
        }
      )
  }
  const gate = async (computerId: string, taskId: string) => {
    assertTaskDelivered(computerId, taskId)
    await opts.gate?.(computerId, taskId)
  }
  const recovery = createChatRecovery({
    db: opts.db,
    request: opts.request,
    onConversationFailure: fence,
    gate: opts.gate,
    recoverTabTransitions: (computerId, identity, transitions) =>
      relay.recoverProviderTransitions(computerId, identity, transitions)
  })
  /** Idempotent; one pass at a time, so concurrent callers share it. */
  let retiring: Promise<void> | null = null
  function retireComputers(): Promise<void> {
    retiring ??= applyComputerRetirements(opts.db).finally(() => {
      retiring = null
    })
    return retiring
  }
  // Hub start: a computer removed while the hub was down stops blocking now.
  void retireComputers().catch((error: unknown) =>
    console.error('[chat] applying computer retirements failed:', error)
  )
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
    // This pass re-decides every fence of this computer.
    for (const [id, f] of fences) if (f.computerId === computerId) fences.delete(id)
    let inventory: ComputerChatInventory[] = []
    let restoredMetadata: ReadonlySet<string> = new Set()
    // Work still addressed to a re-enrolled or removed computer moves or is
    // retired first: this pass must never wait on a computer that is gone.
    const work = retireComputers()
      .then(() => relay.resumeProviderTransitions(computerId))
      .then(() => recovery.reconcile(computerId))
      .then((items) => {
        // An entry without a valid identity was already skipped (and logged).
        inventory = items.filter((entry) => typeof entry?.identity?.id === 'string')
      })
      // Every task's lifecycle the computer holds, against the hub's (tasks
      // without chats too): rebases either side's restore before delivery.
      .then(() => lifecycle.reconcile(computerId))
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
          await isolateItem(
            `migration of conversation ${owner.id} to computer ${computerId}`,
            () => migration.ensure(owner.id, computerId),
            () => unfinished.add(owner.id)
          )
      })
      // Migrated chats hold their settings now: the hub's starting values go.
      .then(() => relay.settleStartingValues(computerId))
      .then(() => folderDeletions.recover(computerId, opts.request, opts.gate))
      .then(async () => {
        const reported = new Map(inventory.map((entry) => [entry.identity.id, entry]))
        restoredMetadata = await relay.drainMetadata(
          computerId,
          true,
          new Set([
            ...unfinished,
            ...[...fences].filter(([, f]) => f.computerId === computerId).map(([id]) => id)
          ]),
          reported
        )
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
        // Drift the passes failed to prevent or repair shows in the logs, not
        // only later as a tab that will not open. Never blocks recovery.
        await checkHubChatConsistency(opts.db)
          .then((violations) => {
            for (const v of violations)
              console.warn(`[chat] consistency: ${v.rule} (${v.ids.join(', ')}): ${v.detail}`)
          })
          .catch((error: unknown) => console.warn('[chat] consistency check failed:', error))
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
    const task = await opts.db.get<{ project_id: string | null }>(
      'SELECT project_id FROM tasks WHERE id=?',
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
    const values = {
      identity: {
        id: owner.id,
        taskId: owner.taskId,
        tabId: owner.tabId,
        mode: owner.mode,
        epoch: owner.epoch + (owner.state === 'active' ? 0 : 1)
      },
      projectId: task.project_id,
      // The hub keeps no task path (§9 7e): the computer starts the chat in the task's
      // own folder there (worktree, else base dir, else its project's folder).
      cwd: '',
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
      env: await opts.legacyData.buildMcpEnv(owner.taskId, owner.mode, computerId)
    }
    // `providerConfig` carries hub-owned spawn flags plus a new chat's starting
    // values; chat settings and the chat session id are the computer's alone
    // (robustness plan §9, decision 2): it never takes them from here again.
    const hash = createHash('sha256').update(JSON.stringify(values)).digest('hex')
    return {
      ...values,
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
    const recorded = (await legacyChatTables(opts.db))
      ? await opts.db.get<{ computer_id: string }>(
          'SELECT computer_id FROM chat_legacy_tab_computers WHERE tab_id=?',
          [owner.tabId]
        )
      : undefined
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
   * Is the hub still the source of this task's legacy chat history (its unmigrated
   * chat events)? Task-wide content migrates with the task's
   * `chat_legacy_task_authority` owner; until that owner activates, the hub's legacy
   * rows are the only copy. Without an authority owner the task has none.
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
   * The computers holding a task's prompt history (robustness plan §9: only there,
   * since v207 even the prompts the hub once held). Reading first runs the task's
   * legacy migration, as every history read does. While that migration is deferred
   * (its agents run, often for days after an upgrade restarts them) the prompts are
   * read anyway, from the computers already holding them: they never wait on it.
   * `deferred`: the task's legacy chat events are still the hub's (its legacy Codex
   * chat prompts count in the session summaries).
   */
  async function promptComputers(
    taskId: string
  ): Promise<{ computers: Set<string>; deferred: boolean }> {
    try {
      const owners = await relay.ensurePromptTask(taskId)
      return { computers: new Set(owners.map((o) => o.computerId!)), deferred: false }
    } catch (error) {
      if (isComputerUnreachable(error)) throw new AgentHistoryOfflineError()
      if (!(error instanceof ChatMigrationDeferredError)) throw error
      const pc = await opts.resolveComputer(taskId)
      const known = (await ownership.forTask(taskId)).flatMap((o) =>
        o.state === 'active' && o.computerId ? [o.computerId] : []
      )
      return {
        computers: new Set([...known, ...(pc ? [pc] : [])]),
        deferred: await hubHoldsTaskHistory(taskId)
      }
    }
  }
  /** One request to a computer holding history; one not connected = offline (no hub copy). */
  async function historyRequest(computerId: string, taskId: string, value: unknown) {
    try {
      await opts.gate?.(computerId, taskId)
      await opts.flushTask?.(taskId, computerId)
      return await request(computerId, value)
    } catch (error) {
      if (isComputerUnreachable(error)) throw new AgentHistoryOfflineError()
      throw error
    }
  }
  async function computerPromptSummaries(taskId: string, conversationIds: string[]) {
    const { computers, deferred } = await promptComputers(taskId)
    type Summary = { conversationId: string; count: number; firstPrompt: string; firstAt: number }
    const result = new Map<string, Summary>()
    for (const computerId of computers) {
      for (let offset = 0; offset < conversationIds.length; offset += 500) {
        const summaries = (await historyRequest(computerId, taskId, {
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
    const merged: Array<{ conversationId: string; count: number; firstPrompt: string }> = [
      ...result.values()
    ]
    if (!deferred) return merged
    // Codex chat prompts of conversations still waiting in the hub's legacy chat
    // events: the larger count of the two sources stands (they overlap once moved).
    const legacy = new Map(
      (await legacyCodexChatPromptSummaries(opts.db, taskId, conversationIds)).map((s) => [
        s.conversationId,
        s
      ])
    )
    const out = merged.map((s) => {
      const l = legacy.get(s.conversationId)
      legacy.delete(s.conversationId)
      return l && l.count > s.count ? l : s
    })
    return [...out, ...legacy.values()]
  }
  async function computerPrompts(taskId: string, agentId?: string) {
    const { computers } = await promptComputers(taskId)
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
    for (const computerId of computers) {
      const prompts = (await historyRequest(computerId, taskId, {
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
  /** One (task, mode) configuration as the chat's computer holds it (the only copy). */
  const computerProviderConfig = async (
    owner: HubChatOwnership,
    mode: string
  ): Promise<{ conversationId?: string | null; chatConversationId?: string | null }> => {
    if (!owner.computerId) return {}
    return ((await request(owner.computerId, {
      kind: 'taskData',
      taskId: owner.taskId,
      request: { kind: 'providerConfig', mode }
    })) ?? {}) as { conversationId?: string | null; chatConversationId?: string | null }
  }
  /**
   * The chat holding a provider session, as the computers answer (robustness plan
   * §9, v208: the hub keeps no provider bindings). Asked: every computer holding an
   * active chat of the task for that provider, and the computer the task resolves
   * to. A computer that cannot be reached cannot answer: when no reachable one holds
   * the session, the start is refused naming it (ProviderSessionHolderOfflineError)
   * — never started where the task resolves, which would fork the session.
   */
  const sessionChatOwner = async (
    taskId: string,
    mode: string,
    sessionId: string
  ): Promise<HubChatOwnership | null> => {
    const provider = terminalStorageAgentId(mode)
    const computers = new Set<string>()
    for (const o of await ownership.forTask(taskId))
      if (
        o.state === 'active' &&
        o.computerId &&
        !isStorageOnlyChatOwner(o) &&
        terminalStorageAgentId(o.mode) === provider
      )
        computers.add(o.computerId)
    const resolved = await opts.resolveComputer(taskId)
    if (resolved) computers.add(resolved)
    const offline: string[] = []
    for (const pc of computers) {
      let found: { conversationId: string } | null
      try {
        found = (await request(pc, {
          kind: 'ledger',
          value: { op: 'chatSessionOwner', args: { sessionId, mode } }
        })) as { conversationId: string } | null
      } catch (error) {
        if (isComputerUnreachable(error)) {
          offline.push(pc)
          continue
        }
        throw error
      }
      if (!found) continue
      const owner = await ownership.get(found.conversationId)
      if (owner?.computerId === pc) return owner
    }
    if (offline.length) {
      const names: string[] = []
      for (const id of offline)
        names.push(
          (
            await opts.db.get<{ name: string | null }>('SELECT name FROM computers WHERE id=?', [
              id
            ])
          )?.name?.trim() || id
        )
      throw new ProviderSessionHolderOfflineError(names)
    }
    return null
  }
  /** The terminal session of (task, mode) — its main tab's — on the chat's computer's ledger. */
  const computerTerminalSession = async (
    owner: HubChatOwnership,
    mode: string
  ): Promise<string | null> => {
    if (!owner.computerId) return null
    return ((await request(owner.computerId, {
      kind: 'ledger',
      value: { op: 'getCurrentConversationId', args: { taskId: owner.taskId, mode } }
    })) ?? null) as string | null
  }
  const relay = createHubChatRelay({
    ...opts,
    gate,
    onConversationFailure: fence,
    conversationFence,
    onSessionsChanged: (taskId) => opts.onSessionsChanged?.(taskId),
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
      // Every session id lives only on the chat's computer (robustness plan §9):
      // the chat's in its configuration, the terminal's in its session ledger.
      const chat = await computerProviderConfig(owner, owner.mode)
      const terminal = await computerTerminalSession(owner, terminalStorageAgentId(owner.mode))
      for (const session of [chat.conversationId, chat.chatConversationId, terminal])
        if (
          session &&
          defaultConversationRegistry.isConversationLive('terminal', owner.taskId, session)
        )
          await defaultConversationRegistry.releaseConversation('terminal', owner.taskId, session)
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
      // Which provider session a command acts on matters only while a terminal of
      // the task runs one: the two sides must never drive one transcript. Whether
      // the session is this computer's is the computer's own check (it refuses a
      // session its ledger does not hold — robustness plan §9, v208), so the hub
      // reads the chat's session id there only when a terminal could collide.
      const first = args[0] as { conversationId?: string } | undefined
      const native = method === 'switchConversation' ? first?.conversationId : undefined
      const terminalLive = defaultConversationRegistry.liveConversations('terminal', owner.taskId)
      const terminalAgentId = terminalAgentIdForChat(owner.mode)
      const session =
        terminalLive?.length === 0
          ? null
          : (native ??
            (['continueInChat', 'takeOver'].includes(method)
              ? terminalAgentId
                ? await computerTerminalSession(owner, terminalAgentId)
                : null
              : (await computerProviderConfig(owner, owner.mode)).chatConversationId))
      if (session) {
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
              'listThreads',
              // A thread's own conversation, not the one the terminal runs.
              'setThreadClosed'
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
      },
      async providerConfig(tabId) {
        if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
        const owner = await relay.ensureTab(tabId)
        return (await computerProviderConfig(owner, owner.mode)) as Record<string, unknown>
      }
    } satisfies NonNullable<ChatDeps['testing']>,
    /**
     * Chat settings of chats a computer owns (robustness plan §9, decision 2): a task
     * update carrying them (a template applied) changes them there; the hub keeps
     * no copy. Installed as the task domain's `ChatSettingsDelegate`.
     */
    chatSettings: {
      async ownedModes(taskId: string): Promise<ReadonlySet<string>> {
        const rows = await opts.db.all<{ mode: string }>(
          `SELECT DISTINCT mode FROM chat_ownership WHERE task_id=? AND state IN ('active','copying','verified')
            AND tab_id NOT LIKE 'artifact-store:%' AND tab_id<>'task-content:'||task_id`,
          [taskId]
        )
        return new Set(rows.map((r) => r.mode))
      },
      async apply(taskId: string, mode: string, settings: Record<string, unknown>) {
        const owner = await opts.db.get<{ tab_id: string; computer_id: string | null }>(
          `SELECT tab_id,computer_id FROM chat_ownership WHERE task_id=? AND mode=? AND state IN ('active','copying','verified')
            AND tab_id NOT LIKE 'artifact-store:%' AND tab_id<>'task-content:'||task_id
            ORDER BY epoch DESC,id LIMIT 1`,
          [taskId, mode]
        )
        if (!owner) throw new Error('The chat is no longer on a computer')
        // The computer resolves the chat's folder itself (the hub keeps no task path).
        const target = { tabId: owner.tab_id, taskId, mode, cwd: '' }
        if (typeof settings.chatMode === 'string')
          await relay.ops.setMode({ ...target, chatMode: settings.chatMode })
        if (typeof settings.chatModel === 'string')
          await relay.ops.setModel({ ...target, chatModel: settings.chatModel })
        if (typeof settings.chatEffort === 'string')
          await relay.ops.setEffort({ ...target, chatEffort: settings.chatEffort })
        if (typeof settings.chatCollaboration === 'string')
          await relay.ops.setCollaboration({
            ...target,
            chatCollaboration: settings.chatCollaboration
          })
        if (typeof settings.chatFastMode === 'boolean')
          await relay.ops.setFastMode({ ...target, chatFastMode: settings.chatFastMode })
      }
    },
    computers,
    /** A computer was deleted or re-enrolled: move or retire the chat work naming it. */
    retireComputers,
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
      // Dropped once every chat migrated (§9 Phase 8): unowned chat tabs still register.
      const tables = await legacyChatTables(opts.db)
      const tasks = new Set(
        (
          await opts.db.all<{ task_id: string }>(
            `SELECT DISTINCT t.task_id FROM terminal_tabs t LEFT JOIN chat_tab_bindings b ON b.tab_id=t.id LEFT JOIN chat_ownership o ON o.id=b.conversation_id
              WHERE (t.mode IN ('claude-chat','codex-chat') OR ${legacyChatTabContentSql(tables)})
              AND (o.id IS NULL OR o.state IN ('legacy','copying','verified') OR o.cleanup_pending=1)
              UNION SELECT task.id AS task_id FROM tasks task WHERE ${legacyChatTaskContentSql(tables)}`
          )
        ).map((t) => t.task_id)
      )
      const ledger = createAsyncFaultLedger(opts.db, { origin: 'hub', computerId })
      // One task's diagnostics that cannot be cleaned (a damaged row, a busy
      // checkpoint) is recorded and retried on its backoff; the migration and the
      // later maintenance stages still run for every other task.
      await forEachIsolated(
        (await opts.diagnostics?.tasks()) ?? [],
        {
          pass: 'hub-legacy-diagnostics-cleanup',
          key: (task) => task,
          taskId: (task) => task,
          ledger,
          isFatal: isComputerUnreachable
        },
        async (task) => {
          const deleted = await opts.db.get(
            "SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted'",
            [task]
          )
          if (deleted && opts.diagnostics) {
            await opts.diagnostics.cleanup(task, await opts.diagnostics.freeze(task))
          } else tasks.add(task)
        }
      )
      for (const taskId of tasks) {
        try {
          if (await opts.hasLiveTask(taskId)) continue
          const owners = await ownership.forTask(taskId)
          const tab = await opts.db.get<{ id: string }>(
            `SELECT t.id FROM terminal_tabs t LEFT JOIN chat_tab_bindings b ON b.tab_id=t.id LEFT JOIN chat_ownership o ON o.id=b.conversation_id WHERE t.task_id=?
              AND (t.mode IN ('claude-chat','codex-chat') OR ${legacyChatTabContentSql(tables)})
              AND (o.id IS NULL OR o.state IN ('legacy','copying','verified') OR o.cleanup_pending=1) ORDER BY t.created_at,t.id LIMIT 1`,
            [taskId]
          )
          const recorded =
            tab && tables
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
          await ledger.clear('hub-legacy-chat-migration', taskId)
        } catch (error) {
          // A disconnected computer: every later task would fail the same way. Stop
          // here (not a fault); the next pass after reconnect retries them all.
          if (isComputerUnreachable(error)) break
          // An active or unplaced task remains fenced and retries next pass; recorded
          // (never silent) so a task that can never migrate shows under Needs attention.
          const failure = toError(error)
          console.error(`[chat] legacy migration of task ${taskId} failed; continuing:`, failure)
          await ledger.record(
            {
              pass: 'hub-legacy-chat-migration',
              itemKey: taskId,
              taskId,
              kind: classifyFault(failure),
              error: failure
            },
            Date.now()
          )
        }
      }
    },
    async captureHook(hook: ResolvedAgentHook, reportedComputer?: string | null) {
      if (!hook.taskId || !agentHookPrompt(hook) || !isPromptCaptureMode(hook.agentId)) return
      // The computer that ran the agent reported the hook: its prompt is stored there.
      const pc = reportedComputer ?? (await opts.resolveComputer(hook.taskId))
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
          const fenced = conversationFence(o.id)
          if (fenced) throw fenced
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
        native && context?.mode ? await sessionChatOwner(taskId, context.mode, native) : null
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
        await gate(owner.computerId, taskId)
        return owner.computerId
      }
      const computerId = await opts.resolveComputer(taskId)
      if (computerId) {
        // Chat recovery guards this task's own chat history on the computer. A
        // task with none there must not inherit another conversation's (or a
        // broken chat store's) recovery failure: native agents and shells start.
        // Storage-only owners (task files, legacy prompt history) are not chat
        // an agent resumes from: their failures surface where they are read.
        const ownsChat = async () =>
          (await ownership.forTask(taskId)).some(
            (o) =>
              o.state !== 'deleted' &&
              !isStorageOnlyChatOwner(o) &&
              (o.computerId === computerId || o.destinationComputerId === computerId)
          )
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
        // A chat task needs all its state delivered (its history depends on
        // it); native work only an undelivered pause or delete.
        assertTaskDelivered(computerId, taskId, !(await ownsChat()))
      }
      return computerId
    },
    async promptSummaries(
      taskId: string,
      conversationIds: string[]
    ): Promise<Array<{ conversationId: string; count: number; firstPrompt: string }>> {
      if (!conversationIds.length) return []
      return computerPromptSummaries(taskId, conversationIds)
    },
    async prompts(taskId: string, agentId?: string) {
      return computerPrompts(taskId, agentId)
    }
  }
}
