import { CHAT_READ_OPERATIONS, type ChatOperation } from '@slayzone/chat-runtime/shared'
import { createHash } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  terminalModeForChat,
  type ChatAttachment,
  type UserContentBlock
} from '@slayzone/terminal-contracts'
import {
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
  hasLiveTask(taskId: string): Promise<boolean>
  beforeInvoke?(owner: HubChatOwnership, method: string, args: unknown[]): Promise<void>
  onState?(sessionId: string, state: ChatTerminalState, previous: ChatTerminalState): void
}) {
  const ownership = createChatOwnershipStore(opts.db)
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
        const existing = (await opts.request(pc, { kind: 'attachment.has', route, ref })) as {
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
      return opts.request(pc, {
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
  const migration = createChatMigration({ ownership, source, request: opts.request })
  const relay = createHubChatRelay({
    ...opts,
    ownership,
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
  return {
    ownership,
    migration,
    relay,
    async resolvePtyComputer(
      taskId: string,
      context?: { mode?: string; conversationId?: string | null }
    ) {
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
        if (owner.taskId !== taskId || owner.state !== 'active' || !owner.computerId)
          throw new Error('Provider session ownership is unavailable')
        await opts.gate?.(owner.computerId, taskId)
        return owner.computerId
      }
      return opts.resolveComputer(taskId)
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
        const prompts = (await opts.request(computerId, {
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
