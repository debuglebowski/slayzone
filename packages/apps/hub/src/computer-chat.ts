import { CHAT_READ_OPERATIONS, type ChatOperation } from '@slayzone/chat-runtime/shared'
import { createHash } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  terminalModeForChat,
  type ChatComputerOps,
  type ChatAttachment,
  type UserContentBlock
} from '@slayzone/terminal-contracts'
import {
  createChatRecovery,
  createChatLifecycle,
  createChatOwnershipStore,
  createChatMigration,
  createLegacyChatSource,
  createHubChatRelay,
  type ChatComputerRequest,
  type HubChatOwnership,
  type ChatBootstrap
} from '@slayzone/chat-runtime/server'
import {
  defaultConversationRegistry,
  type ChatDataOps,
  type ChatAttachmentReader,
  type ChatTerminalState
} from '@slayzone/terminal/runtime'

export function createComputerChatServices(opts: {
  db: SlayzoneDb
  legacyData: ChatDataOps
  attachments: ChatAttachmentReader
  request: ChatComputerRequest
  resolveComputer(taskId: string): Promise<string | null>
  defaultComputer(): Promise<string | null>
  gate?(computerId: string, taskId: string): Promise<void>
  admitComputer?(computerId: string): Promise<void>
  hasLiveTask(taskId: string): Promise<boolean>
  beforeInvoke?(owner: HubChatOwnership, method: string, args: unknown[]): Promise<void>
  onState?(sessionId: string, state: ChatTerminalState, previous: ChatTerminalState): void
}) {
  const ownership = createChatOwnershipStore(opts.db)
  const lifecycle = createChatLifecycle({ db: opts.db, request: opts.request })
  const request = lifecycle.request
  const recovery = createChatRecovery({ db: opts.db, request: opts.request, gate: opts.gate })
  const recovered = new Map<string, Promise<void>>()
  function recoverComputer(computerId: string, force = false) {
    if (force) recovered.delete(computerId)
    const existing = recovered.get(computerId)
    if (existing) return existing
    const work = recovery
      .reconcile(computerId)
      .then(() => relay.drainMetadata(computerId, true))
      .then(() => lifecycle.sync(computerId))
      .catch((error) => {
        recovered.delete(computerId)
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
    const computerId = owner.destinationComputerId ?? owner.computerId
    if (!computerId) throw new Error('Chat computer is unassigned')
    const terminalMode = terminalModeForChat(owner.mode) ?? owner.mode
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
      terminalProviderConfig: await opts.legacyData.readProviderConfig(owner.taskId, terminalMode),
      defaultFlags: await opts.legacyData.getModeDefaultFlags(owner.mode),
      env: await opts.legacyData.buildMcpEnv(owner.taskId, owner.mode, computerId),
      deletedConversations: await opts.db.all<{ mode: string; conversationId: string }>(
        'SELECT mode,conversation_id AS conversationId FROM session_deletions WHERE task_id=?',
        [owner.taskId]
      ),
      honoredConversations: (
        await opts.db.all<{ conversation_id: string }>(
          "SELECT DISTINCT conversation_id FROM task_conversations WHERE task_id=? AND mode IN (?,?) AND conversation_id IS NOT NULL AND origin NOT IN ('foreign-observed','pending-spawn')",
          [owner.taskId, owner.mode, terminalMode]
        )
      ).map((r) => r.conversation_id)
    }
    const hash = createHash('sha256').update(JSON.stringify(values)).digest('hex')
    return { ...values, revision: await ownership.settingsRevision(owner.id, hash) }
  }
  const source = createLegacyChatSource({
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
    quiesce: async (owner) => {
      if (await opts.hasLiveTask(owner.taskId))
        throw new Error(
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
  const relay = createHubChatRelay({
    ...opts,
    request,
    ownership,
    recoverComputer,
    bootstrap,
    migrate: migration.ensure,
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
      const terminalMode = terminalModeForChat(owner.mode)
      const terminal = terminalMode
        ? await opts.legacyData.readProviderConfig(owner.taskId, terminalMode)
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
          if (['continueInChat', 'takeOver'].includes(method))
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
          )
            throw new Error(
              'This conversation is running in the terminal. Continue in chat to stop it there first.'
            )
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
      }) as ReturnType<ChatComputerOps['archiveAttachment']>
  }
  return {
    computers,
    recoverComputer,
    ownership,
    migration,
    relay,
    lifecycle,
    async resolvePtyComputer(
      taskId: string,
      context?: { mode?: string; conversationId?: string | null }
    ) {
      const lifecycleState = await opts.db.get<{ state: string }>(
        'SELECT state FROM chat_task_lifecycle WHERE task_id=?',
        [taskId]
      )
      if (lifecycleState && lifecycleState.state !== 'active')
        throw new Error('This task is paused or deleted. Restore it before starting an agent.')
      if (
        await opts.db.get(
          "SELECT 1 FROM chat_ownership WHERE task_id=? AND (state IN ('copying','verified') OR cleanup_pending=1) LIMIT 1",
          [taskId]
        )
      )
        throw new Error(
          'Chat history migration is pending. Reopen chat before starting this agent.'
        )
      const native =
        context?.conversationId ??
        (context?.mode
          ? await opts.legacyData.getCurrentConversationId(taskId, context.mode)
          : null)
      const owner =
        native && context?.mode ? await ownership.forProviderSession(native, context.mode) : null
      if (owner) {
        await recoverComputer(owner.computerId!)
        await lifecycle.sync(owner.computerId!)
        if (owner.taskId !== taskId || owner.state !== 'active' || !owner.computerId)
          throw new Error('Provider session ownership is unavailable')
        await opts.gate?.(owner.computerId, taskId)
        return owner.computerId
      }
      const computerId = await opts.resolveComputer(taskId)
      if (computerId) {
        await recoverComputer(computerId)
        await lifecycle.track(taskId, computerId)
        await lifecycle.sync(computerId)
      }
      return computerId
    },
    async prompts(taskId: string, agentId?: string) {
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
  }
}
