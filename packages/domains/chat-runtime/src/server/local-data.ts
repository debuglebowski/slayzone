import { randomUUID } from 'node:crypto'
import type {
  ChatDataOps,
  ChatQueueData,
  ProviderConfigEntry,
  TimelineWrite,
  ChatThreadStore
} from '@slayzone/terminal/runtime'
import type {
  ChatDraft,
  ChatScrollAnchor,
  ChatTabState,
  ChatThread,
  QueuedChatMessage,
  UserContentBlock,
  ChatAttachment,
  CliCommandList,
  CliCommandDetails,
  ChatModelInfo
} from '@slayzone/terminal-contracts'
import {
  userMessageAttachments,
  chatModeForTerminal,
  isSyntheticChatPrompt,
  chatCapabilitiesForMode,
  defaultChatModeSettingKey,
  resolveDefaultChatMode
} from '@slayzone/terminal-contracts'
import type { ChatRecordKind, ConversationIdentity } from '../shared'
import type { ChatStorage } from './storage'
import { trimLocalPromptHistory } from './prompts'

export interface ChatBootstrap {
  identity: ConversationIdentity
  projectId: string | null
  cwd: string
  revision: number
  providerConfig: ProviderConfigEntry
  defaultFlags: string | null
  settings?: Record<string, string | null>
  env: Record<string, string>
  terminalProviderConfig?: ProviderConfigEntry
  honoredConversations?: string[]
  honoredSessions?: Array<{ mode: string; conversationId: string }>
  deletedConversations?: Array<{ mode: string; conversationId: string }>
}
export interface ChatMetadataUpdate {
  operationId: string
  sequence: number
  conversationId: string
  taskId: string
  tabId: string
  epoch: number
  kind:
    | 'provider-config'
    | 'conversation'
    | 'activity'
    | 'thread-created'
    | 'queue-item'
    | 'agent-state'
    | 'artifact-changed'
    | 'artifact-deleted'
    | 'folder-changed'
    | 'folder-deleted'
  value: unknown
}

export interface ChatMetadataSnapshot {
  identity: ConversationIdentity
  counter: number
  updates: ChatMetadataUpdate[]
}

/** Content stays local. Only explicitly constructed metadata is forwarded to the hub. */
export function createLocalChatData(
  store: ChatStorage,
  notify: (update: ChatMetadataUpdate) => void = () => undefined
) {
  function owner(tabId: string) {
    const o = store.forTab(tabId)
    if (!o) throw new Error('Unknown computer-owned chat tab')
    return o.identity
  }
  function get<T>(tabId: string, kind: ChatRecordKind, key: string): T | null {
    const i = owner(tabId)
    return store.getRecord<T>(i.id, kind, key)
  }
  function set(tabId: string, kind: ChatRecordKind, key: string, value: unknown) {
    const i = owner(tabId)
    store.putRecord(i.id, i.epoch, { kind, id: key, value, at: Date.now() })
  }
  function remove(tabId: string, kind: ChatRecordKind, key: string) {
    const i = owner(tabId)
    store.removeRecord(i.id, i.epoch, kind, key)
  }
  function taskTab(taskId: string, mode?: string) {
    const choices = store
      .listForTask(taskId)
      .filter(
        (r) =>
          r.state !== 'deleted' &&
          !store.getRecord(r.identity.id, 'settings', 'inbox') &&
          (!mode || r.identity.mode === (chatModeForTerminal(mode) ?? mode))
      )
    const root =
      choices.find((r) => !store.getRecord(r.identity.id, 'settings', 'thread-parent')) ??
      choices[0]
    if (!root) throw new Error('Task has no computer-owned conversation')
    return root.identity.tabId
  }
  function metadata(tabId: string, kind: ChatMetadataUpdate['kind'], value: unknown) {
    return store.transaction(() => {
      const i = owner(tabId),
        operationId = randomUUID()
      const sequence = (get<number>(tabId, 'settings', 'metadata-counter') ?? 0) + 1
      set(tabId, 'settings', 'metadata-counter', sequence)
      const update = {
        operationId,
        sequence,
        conversationId: i.id,
        taskId: i.taskId,
        tabId,
        epoch: i.epoch,
        kind,
        value
      }
      // Retain until acknowledged: hub disconnect must not lose resume bindings.
      set(tabId, 'settings', `metadata:${operationId}`, update)
      if (kind === 'activity' || kind === 'agent-state' || kind === 'thread-created')
        set(tabId, 'settings', `metadata-state:${kind}`, value)
      queueMicrotask(() => {
        try {
          if (get(tabId, 'settings', `metadata:${operationId}`)) notify(update)
        } catch {
          /* Runtime may have shut down before this notification. */
        }
      })
    })
  }
  function provider(taskId: string, mode: string): ProviderConfigEntry {
    const tabId = taskTab(taskId, mode)
    return (
      get<ProviderConfigEntry>(
        tabId,
        'settings',
        owner(tabId).mode === mode ? 'provider' : `provider:${mode}`
      ) ?? {}
    )
  }
  function patchSync(taskId: string, mode: string, key: keyof ProviderConfigEntry, value: unknown) {
    store.transaction(() => {
      const tabId = taskTab(taskId, mode),
        next = { ...provider(taskId, mode), [key]: value }
      set(tabId, 'settings', owner(tabId).mode === mode ? 'provider' : `provider:${mode}`, next)
      metadata(tabId, 'provider-config', { mode, key, value })
    })
  }
  async function patch(
    taskId: string,
    mode: string,
    key: keyof ProviderConfigEntry,
    value: unknown
  ) {
    patchSync(taskId, mode, key, value)
  }

  function deleted(taskId: string, mode: string, id: string | null | undefined) {
    return (
      !!id &&
      store
        .findRecords('settings', taskId)
        .some(
          (r) =>
            r.id === 'deleted-sessions' &&
            (r.value as Array<{ mode: string; conversationId: string }>).some(
              (v) => v.mode === mode && v.conversationId === id
            )
        )
    )
  }
  function bootstrap(value: ChatBootstrap) {
    const existing = store.conversation(value.identity.id)
    store.createConversation(value.identity)
    if (value.identity.tabId.startsWith('artifact-store:'))
      set(value.identity.tabId, 'settings', 'inbox', true)
    store.transaction(() => {
      const previous =
        get<Array<{ mode: string; conversationId: string }>>(
          value.identity.tabId,
          'settings',
          'deleted-sessions'
        ) ?? []
      const all = new Map(previous.map((v) => [`${v.mode}:${v.conversationId}`, v]))
      for (const v of value.deletedConversations ?? []) all.set(`${v.mode}:${v.conversationId}`, v)
      if (all.size) set(value.identity.tabId, 'settings', 'deleted-sessions', [...all.values()])
    })
    const previous = store.getRecord<ChatBootstrap>(value.identity.id, 'settings', 'bootstrap')
    if (!previous || value.revision > previous.revision) {
      if (value.settings) {
        const settingsId = {
          id: '__slz_settings__',
          taskId: '__slz_settings__',
          tabId: '__slz_settings__',
          mode: 'claude-chat',
          epoch: 1
        }
        store.createConversation(settingsId)
        for (const [id, setting] of Object.entries(value.settings))
          store.putRecord(settingsId.id, 1, {
            kind: 'settings',
            id,
            value: setting,
            at: Date.now()
          })
      }
      set(value.identity.tabId, 'settings', 'bootstrap', value)
      if (!existing || value.revision > (previous?.revision ?? -1)) {
        // Session ids are computer-authoritative once an agent has confirmed them.
        const local = get<ProviderConfigEntry>(value.identity.tabId, 'settings', 'provider')
        set(value.identity.tabId, 'settings', 'provider', {
          ...value.providerConfig,
          ...(local?.chatConversationId &&
          !deleted(value.identity.taskId, value.identity.mode, local.chatConversationId)
            ? { chatConversationId: local.chatConversationId }
            : {})
        })
      }
    }
    if (value.terminalProviderConfig) {
      const mode = value.identity.mode === 'claude-chat' ? 'claude-code' : 'codex'
      if (!previous || value.revision > previous.revision)
        set(value.identity.tabId, 'settings', `provider:${mode}`, value.terminalProviderConfig)
    }
    for (const id of value.honoredConversations ?? [])
      if (!get(value.identity.tabId, 'settings', `session:${id}`))
        set(value.identity.tabId, 'settings', `session:${id}`, { conversationId: id })
    for (const session of value.honoredSessions ?? [])
      set(
        value.identity.tabId,
        'settings',
        `session-proof:${session.mode}:${session.conversationId}`,
        true
      )
  }
  const queued = (tabId: string): QueuedChatMessage[] =>
    store
      .records(owner(tabId).id)
      .filter((r) => r.kind === 'queue')
      .map((r) => r.value as QueuedChatMessage)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  function queueItem(id: string) {
    const r = store.findRecords('queue').find((r) => r.id === id)
    return r ? (r.value as QueuedChatMessage) : null
  }
  type SyncQueueData = {
    [K in keyof ChatQueueData]: (
      ...args: Parameters<ChatQueueData[K]>
    ) => Awaited<ReturnType<ChatQueueData[K]>>
  }
  const queueSync: SyncQueueData = {
    list: (tabId) => queued(tabId),
    push: (tabId, send, original, opts) => {
      const id = opts?.id ?? randomUUID(),
        previous = queueItem(id)
      if (previous) {
        if (
          previous.tabId !== tabId ||
          previous.send !== send ||
          JSON.stringify(previous.content) !== JSON.stringify(opts?.content)
        )
          throw new Error('Queue operation id conflict')
        return previous
      }
      const list = queued(tabId)
      const item: QueuedChatMessage = {
        id,
        tabId,
        send,
        original,
        position: (list.at(-1)?.position ?? -1) + 1,
        createdAt: new Date().toISOString(),
        ...(opts?.content ? { content: opts.content } : {}),
        ...(opts?.expectedConversationId
          ? { expectedConversationId: opts.expectedConversationId }
          : {})
      }
      set(tabId, 'queue', id, item)
      metadata(tabId, 'queue-item', { id, removed: false })
      return item
    },
    pop: (tabId, held = []) => {
      const item = queued(tabId)[0]
      if (!item || held.includes(item.id)) return null
      // Keep the row until its user-message event commits in the same transaction.
      return item
    },
    update: (id, next) => {
      const item = queueItem(id)
      if (!item) return false
      set(item.tabId, 'queue', id, { ...item, ...next })
      return true
    },
    move: (id, toIndex) => {
      const item = queueItem(id)
      if (!item) return false
      const list = queued(item.tabId).filter((i) => i.id !== id)
      list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, item)
      for (let n = 0; n < list.length; n++)
        set(item.tabId, 'queue', list[n].id, { ...list[n], position: n })
      return true
    },
    requeue: (item) => {
      set(item.tabId, 'queue', item.id, {
        ...item,
        position: (queued(item.tabId)[0]?.position ?? 0) - 1
      })
    },
    remove: (id) => {
      const item = queueItem(id)
      if (!item) return false
      remove(item.tabId, 'queue', id)
      metadata(item.tabId, 'queue-item', { id, removed: true })
      return true
    },
    clear: (tabId) => {
      const list = queued(tabId)
      for (const item of list) {
        remove(tabId, 'queue', item.id)
        metadata(tabId, 'queue-item', { id: item.id, removed: true })
      }
      return list.length
    },
    getTabIdForItem: (id) => queueItem(id)?.tabId ?? null
  }
  function atomic<A extends unknown[], R>(action: (...args: A) => R): (...args: A) => Promise<R> {
    return async (...args) => store.transaction(() => action(...args))
  }
  const queue: ChatQueueData = {
    list: atomic(queueSync.list),
    push: atomic(queueSync.push),
    pop: atomic(queueSync.pop),
    update: atomic(queueSync.update),
    move: atomic(queueSync.move),
    requeue: atomic(queueSync.requeue),
    remove: atomic(queueSync.remove),
    clear: atomic(queueSync.clear),
    getTabIdForItem: atomic(queueSync.getTabIdForItem)
  }
  const threads: ChatThreadStore = {
    get: async (id) =>
      store.findRecords('thread').find((r) => r.id === id)?.value as ChatThread | undefined,
    listForParent: async (tabId) =>
      store
        .records(owner(tabId).id)
        .filter((r) => r.kind === 'thread')
        .map((r) => r.value as ChatThread)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    list: async (tabId, conversationId) =>
      (await threads.listForParent(tabId)).filter((t) => t.parentConversationId === conversationId),
    create: async (thread) => {
      const p = owner(thread.parentTabId)
      const context = get<ChatBootstrap>(thread.parentTabId, 'settings', 'bootstrap')!
      bootstrap({
        ...context,
        identity: { ...p, id: randomUUID(), tabId: thread.id, mode: thread.mode }
      })
      set(thread.id, 'settings', 'thread-parent', thread.parentTabId)
      set(thread.parentTabId, 'thread', thread.id, thread)
      metadata(thread.id, 'thread-created', {
        parentTabId: thread.parentTabId,
        mode: thread.mode,
        parentConversationId: thread.parentConversationId,
        answerId: thread.answerId,
        sourceMessageId: thread.sourceMessageId,
        sourceUuid: thread.sourceUuid,
        createdAt: thread.createdAt
      })
    },
    setConversation: async (id, conversationId) => {
      const thread = await threads.get(id)
      if (thread) set(thread.parentTabId, 'thread', id, { ...thread, conversationId })
    }
  }
  function allAttachments(taskId?: string) {
    return store.findRecords('attachment', taskId).map(
      (r) =>
        r.value as {
          taskId: string
          artifactId: string
          contentHash: string
          name: string
          size: number
          kind: string
          mediaType: string
        }
    )
  }
  const data: ChatDataOps = {
    threads,
    readProviderConfig: async (taskId, mode) => provider(taskId, mode),
    writeChatMode: (t, m, v) => patch(t, m, 'chatMode', v),
    writeChatModel: (t, m, v) => patch(t, m, 'chatModel', v),
    writeChatEffort: (t, m, v) => patch(t, m, 'chatEffort', v),
    writeChatCollaboration: (t, m, v) => patch(t, m, 'chatCollaboration', v),
    writeChatFastMode: (t, m, v) => patch(t, m, 'chatFastMode', v),
    clearChatConversationId: (t, m) => patch(t, m, 'chatConversationId', null),
    readSetting: async (key) =>
      store.getRecord<string | null>('__slz_settings__', 'settings', key) || null,
    getDefaultChatMode: async (mode) =>
      resolveDefaultChatMode(mode, await data.readSetting(defaultChatModeSettingKey(mode))),
    getModeDefaultFlags: async (mode) => {
      const tab = store
        .findRecords('settings')
        .find((r) => r.id === 'bootstrap' && (r.value as ChatBootstrap).identity.mode === mode)
      return (tab?.value as ChatBootstrap | undefined)?.defaultFlags ?? null
    },
    recordConversation: async (input) => {
      store.transaction(() => {
        const tabId = taskTab(input.taskId, input.mode)
        const value = { ...input, createdAt: input.createdAt ?? Date.now() }
        set(tabId, 'settings', `session:${input.conversationId ?? 'reset'}`, value)
        if (input.conversationId)
          set(tabId, 'settings', `session-proof:${input.mode}:${input.conversationId}`, true)
        patchSync(
          input.taskId,
          input.mode,
          input.legacyJsonField ?? 'conversationId',
          input.conversationId
        )
        metadata(tabId, 'conversation', value)
      })
    },
    isHonoredConversation: async (t, m, id) => {
      if (deleted(t, m, id)) return false
      const tabId = taskTab(t, m),
        session = get<{ mode?: string }>(tabId, 'settings', `session:${id}`)
      return (
        Boolean(get(tabId, 'settings', `session-proof:${m}:${id}`)) ||
        Boolean(session && (session.mode ?? owner(tabId).mode) === m) ||
        [provider(t, m).chatConversationId, provider(t, m).conversationId].includes(id)
      )
    },
    getCurrentConversationId: async (t, m) => {
      const id =
        (chatModeForTerminal(m)
          ? provider(t, m).conversationId
          : provider(t, m).chatConversationId) ?? null
      return deleted(t, m, id) ? null : id
    },
    bumpLastInteraction: async (taskId, now) => {
      metadata(taskTab(taskId), 'activity', { at: now })
      return true
    },
    persistChatEventSync: (tabId, seq, event, at) =>
      store.transaction(() => {
        const i = owner(tabId)
        const outcome = store.appendAt(i.id, i.epoch, seq, event, at)
        if (
          outcome === 'inserted' &&
          event.kind === 'user-message' &&
          !event.history &&
          event.id &&
          store.getRecord(i.id, 'queue', event.id)
        ) {
          remove(tabId, 'queue', event.id)
          metadata(tabId, 'queue-item', { id: event.id, removed: true })
        }
        if (
          outcome === 'inserted' &&
          event.kind === 'user-message' &&
          !event.history &&
          event.id &&
          event.text.trim() &&
          !isSyntheticChatPrompt(event.text)
        ) {
          const cap = chatCapabilitiesForMode(i.mode)
          if (cap.promptHistory || cap.sessions) {
            set(tabId, 'prompt', event.id, {
              id: event.id,
              taskId: i.taskId,
              agentId: i.mode,
              cliSessionId: provider(i.taskId, i.mode).chatConversationId ?? null,
              text: event.text,
              createdAt: at
            })
            trimLocalPromptHistory(store, i.taskId, i.mode)
          }
        }
        if (outcome === 'inserted' && event.kind === 'workspace-changes') {
          const record = store.getRecord<{ needsRecoveryEvent?: boolean }>(
            i.id,
            'workspace',
            event.captureId
          )
          if (record?.needsRecoveryEvent)
            set(tabId, 'workspace', event.captureId, { ...record, needsRecoveryEvent: false })
        }
        if (
          outcome === 'inserted' &&
          event.kind === 'user-message-delivery' &&
          ['delivered', 'answered'].includes(event.state)
        ) {
          const prompt = get<{ id: string; cliSessionId: string | null; createdAt: number }>(
            tabId,
            'prompt',
            event.id
          )
          const conversationId = provider(i.taskId, i.mode).chatConversationId
          if (prompt && conversationId && prompt.cliSessionId !== conversationId)
            store.putRecord(i.id, i.epoch, {
              kind: 'prompt',
              id: prompt.id,
              value: { ...prompt, cliSessionId: conversationId },
              at: prompt.createdAt
            })
        }
        return outcome
      }),
    persistChatEvent: async (tabId, seq, event, at) =>
      data.persistChatEventSync!(tabId, seq, event, at ?? Date.now()),
    loadChatEvents: async (tabId) => store.read(owner(tabId).id, -1),
    loadChatEventsRange: async (tabId, after, before) => store.read(owner(tabId).id, after, before),
    getNextSeqForTab: async (tabId) => store.nextSeq(owner(tabId).id),
    clearChatEventsForTab: async (tabId) => {
      const i = owner(tabId)
      store.clearHistory(i.id, i.epoch)
    },
    loadUserMessageContent: async (taskId, ids) => {
      const found = new Map<string, UserContentBlock[]>()
      for (const o of store.listForTask(taskId))
        for (const e of store.read(o.identity.id, -1))
          if (e.event.kind === 'user-message' && e.event.id && ids.includes(e.event.id))
            found.set(e.event.id, e.event.content ?? [])
      for (const r of store.findRecords('settings', taskId))
        if (r.id.startsWith('attachment-message:') && ids.includes(r.id.slice(19)))
          found.set(
            r.id.slice(19),
            (r.value as ChatAttachment[]).map((attachment) => ({ type: 'attachment', attachment }))
          )
      return found
    },
    loadTimelineCheckpoint: async (tabId) => get(tabId, 'timeline', 'checkpoint'),
    loadTimelinePages: async (tabId, pages) =>
      pages.flatMap((page) => {
        const r = get<{ rows: string }>(tabId, 'timeline', `page:${page}`)
        return r ? [{ page, rows: r.rows }] : []
      }),
    loadTimelineSummaries: async (tabId) =>
      store
        .records(owner(tabId).id)
        .filter((r) => r.kind === 'timeline' && r.id.startsWith('page:'))
        .map((r) => ({
          page: Number(r.id.slice(5)),
          summary: (r.value as { summary: string }).summary
        }))
        .sort((a, b) => a.page - b.page),
    saveTimeline: async (tabId, write: TimelineWrite) =>
      store.transaction(() => {
        if (write.dropPagesFrom !== null)
          for (const r of store.records(owner(tabId).id))
            if (
              r.kind === 'timeline' &&
              r.id.startsWith('page:') &&
              Number(r.id.slice(5)) >= write.dropPagesFrom
            )
              remove(tabId, 'timeline', r.id)
        for (const p of write.pages) set(tabId, 'timeline', `page:${p.page}`, p)
        if (write.checkpoint) set(tabId, 'timeline', 'checkpoint', write.checkpoint)
        else remove(tabId, 'timeline', 'checkpoint')
      }),
    searchTimelinePages: async (tabId, needle) =>
      store
        .records(owner(tabId).id)
        .filter(
          (r) =>
            r.kind === 'timeline' &&
            r.id.startsWith('page:') &&
            (r.value as { searchText: string }).searchText.includes(needle)
        )
        .map((r) => Number(r.id.slice(5)))
        .sort((a, b) => a - b),
    clearTimeline: async (tabId) => {
      for (const r of store.records(owner(tabId).id))
        if (r.kind === 'timeline') remove(tabId, 'timeline', r.id)
    },
    clearChatQueue: (tabId) => queue.clear(tabId),
    buildMcpEnv: async (taskId) =>
      get<ChatBootstrap>(taskTab(taskId), 'settings', 'bootstrap')?.env ?? {},
    resolveComputerId: async () => null,
    getTaskProjectId: async (taskId) =>
      get<ChatBootstrap>(taskTab(taskId), 'settings', 'bootstrap')?.projectId ?? null,
    getProjectRoot: async () => null,
    bumpAutocompleteUsage: async (source, name) => {
      const tabId = store.findRecords('settings').find((r) => r.id === 'bootstrap')?.value as
        | ChatBootstrap
        | undefined
      if (!tabId) return
      const key = `usage:${source}:${name}`
      set(
        tabId.identity.tabId,
        'settings',
        key,
        (get<number>(tabId.identity.tabId, 'settings', key) ?? 0) + 1
      )
    },
    getAutocompleteUsage: async () => {
      const out: Record<string, Record<string, number>> = {}
      for (const r of store.findRecords('settings'))
        if (r.id.startsWith('usage:')) {
          const [, source, ...parts] = r.id.split(':')
          out[source] ??= {}
          out[source][parts.join(':')] = r.value as number
        }
      return out
    },
    saveCliSnapshot: async (t, m, v) => set(taskTab(t, m), 'settings', 'cli-snapshot', v),
    getCliSnapshot: async (t, m) => get<CliCommandList>(taskTab(t, m), 'settings', 'cli-snapshot'),
    saveCliCommandDetails: async (t, m, v) => set(taskTab(t, m), 'settings', 'cli-details', v),
    getCliCommandDetails: async (t, m) =>
      get<CliCommandDetails>(taskTab(t, m), 'settings', 'cli-details'),
    saveCliModels: async (t, m, v) => set(taskTab(t, m), 'settings', 'cli-models', v),
    getCliModels: async (t, m) => get<ChatModelInfo[]>(taskTab(t, m), 'settings', 'cli-models'),
    getTabState: async (tabId) => get<ChatTabState>(tabId, 'draft', 'state'),
    saveTabDraft: async (tabId, draft: ChatDraft) => {
      const state = get<ChatTabState>(tabId, 'draft', 'state')
      const rev = (state?.draft.rev ?? 0) + 1
      set(tabId, 'draft', 'state', { draft: { ...draft, rev }, scroll: state?.scroll ?? null })
      return { rev }
    },
    saveTabScroll: async (tabId, anchor: ChatScrollAnchor) => {
      const state = get<ChatTabState>(tabId, 'draft', 'state')
      set(tabId, 'draft', 'state', {
        draft: state?.draft ?? { text: '', attachments: [], rev: 0 },
        scroll: anchor
      })
    },
    attachments: {
      tab: async (tabId) => {
        const i = owner(tabId)
        return { taskId: i.taskId, mode: i.mode }
      },
      artifacts: async (ids) =>
        new Map(
          allAttachments()
            .filter((a) => ids.includes(a.artifactId))
            .map((a) => [a.artifactId, { taskId: a.taskId, contentHash: a.contentHash }])
        ),
      queued: async (tabId, except) =>
        queued(tabId)
          .filter((q) => q.id !== except)
          .flatMap((q) => userMessageAttachments(q.content ?? [])),
      hasVersion: async (id, hash) =>
        allAttachments().some((a) => a.artifactId === id && a.contentHash === hash)
    }
  }
  function metadataSnapshot(id: string): ChatMetadataSnapshot {
    return store.transaction(() => {
      const o = store.conversation(id)
      if (!o || o.state !== 'active') throw new Error('Metadata snapshot owner is unavailable')
      const i = o.identity,
        records = store.records(id),
        counter = store.getRecord<number>(id, 'settings', 'metadata-counter') ?? 0
      const updates: ChatMetadataUpdate[] = []
      if (i.tabId.startsWith('artifact-store:')) return { identity: i, counter, updates }
      const add = (kind: ChatMetadataUpdate['kind'], key: string, value: unknown) =>
        updates.push({
          operationId: `snapshot:${id}:${key}`,
          sequence: counter,
          conversationId: id,
          taskId: i.taskId,
          tabId: i.tabId,
          epoch: i.epoch,
          kind,
          value
        })
      const parent = store.getRecord<string>(id, 'settings', 'thread-parent')
      if (parent) {
        const thread = store.findRecords('thread', i.taskId).find((r) => r.id === i.tabId)?.value as
          | ChatThread
          | undefined
        if (thread)
          add('thread-created', 'thread', {
            parentTabId: parent,
            mode: i.mode,
            parentConversationId: thread.parentConversationId,
            answerId: thread.answerId,
            sourceMessageId: thread.sourceMessageId,
            sourceUuid: thread.sourceUuid,
            createdAt: thread.createdAt
          })
      }
      for (const r of records) {
        if (r.kind === 'settings' && r.id.startsWith('session:')) {
          const v = r.value as {
            conversationId?: string | null
            mode?: string
            origin?: string
            createdAt?: number
          }
          if (
            (v.conversationId && !deleted(i.taskId, v.mode ?? i.mode, v.conversationId)) ||
            (v.conversationId === null && v.origin === 'manual-reset')
          )
            add('conversation', r.id, {
              mode: v.mode ?? i.mode,
              conversationId: v.conversationId,
              origin: v.origin ?? 'legacy-migration',
              createdAt: v.createdAt ?? r.at,
              legacyJsonField: (v.mode ?? i.mode).endsWith('-chat')
                ? 'chatConversationId'
                : 'conversationId'
            })
        }
        if (r.kind === 'settings' && (r.id === 'provider' || r.id.startsWith('provider:'))) {
          const mode = r.id === 'provider' ? i.mode : r.id.slice(9),
            cfg = r.value as ProviderConfigEntry
          for (const key of [
            'chatMode',
            'chatModel',
            'chatEffort',
            'chatCollaboration',
            'chatFastMode',
            'chatConversationId',
            'conversationId'
          ] as const) {
            if (cfg[key] !== undefined)
              add('provider-config', `${r.id}:${key}`, {
                mode,
                key,
                value: deleted(i.taskId, mode, typeof cfg[key] === 'string' ? cfg[key] : null)
                  ? null
                  : cfg[key]
              })
          }
        }
        if (r.kind === 'queue') add('queue-item', `queue:${r.id}`, { id: r.id, removed: false })
        if (r.kind === 'settings' && r.id === 'metadata-state:activity')
          add('activity', 'activity', r.value)
        if (r.kind === 'settings' && r.id === 'metadata-state:agent-state')
          add('agent-state', 'agent-state', r.value)
      }
      return { identity: i, counter, updates }
    })
  }
  return { data, queue, bootstrap, owner, get, set, remove, metadata, metadataSnapshot }
}
