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
import { userMessageAttachments } from '@slayzone/terminal-contracts'
import type { ChatRecordKind, ConversationIdentity } from '../shared'
import type { ChatStorage } from './storage'

export interface ChatBootstrap {
  identity: ConversationIdentity
  projectId: string | null
  cwd: string
  revision: number
  providerConfig: ProviderConfigEntry
  defaultFlags: string | null
  env: Record<string, string>
}
export interface ChatMetadataUpdate {
  operationId: string
  conversationId: string
  taskId: string
  tabId: string
  epoch: number
  kind: 'provider-config' | 'conversation' | 'activity' | 'thread-created' | 'queue-item'
  value: unknown
}

/** Content stays local. Only explicitly constructed metadata is forwarded to the hub. */
export function createLocalChatData(
  store: ChatStorage,
  notify: (update: ChatMetadataUpdate) => void = () => {}
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
      .filter((r) => r.state !== 'deleted' && (!mode || r.identity.mode === mode))
    const root =
      choices.find((r) => !store.getRecord(r.identity.id, 'settings', 'thread-parent')) ??
      choices[0]
    if (!root) throw new Error('Task has no computer-owned conversation')
    return root.identity.tabId
  }
  function metadata(tabId: string, kind: ChatMetadataUpdate['kind'], value: unknown) {
    const i = owner(tabId),
      operationId = randomUUID()
    const update = {
      operationId,
      conversationId: i.id,
      taskId: i.taskId,
      tabId,
      epoch: i.epoch,
      kind,
      value
    }
    // Retain until acknowledged: hub disconnect must not lose resume bindings.
    set(tabId, 'settings', `metadata:${operationId}`, update)
    queueMicrotask(() => {
      try {
        if (get(tabId, 'settings', `metadata:${operationId}`)) notify(update)
      } catch {
        /* Runtime may have shut down before this notification. */
      }
    })
  }
  function provider(taskId: string, mode: string): ProviderConfigEntry {
    return get<ProviderConfigEntry>(taskTab(taskId, mode), 'settings', 'provider') ?? {}
  }
  async function patch(
    taskId: string,
    mode: string,
    key: keyof ProviderConfigEntry,
    value: unknown
  ) {
    const tabId = taskTab(taskId, mode)
    const next = { ...provider(taskId, mode), [key]: value }
    set(tabId, 'settings', 'provider', next)
    metadata(tabId, 'provider-config', { mode, key, value })
  }
  function bootstrap(value: ChatBootstrap) {
    const existing = store.conversation(value.identity.id)
    store.createConversation(value.identity)
    const previous = store.getRecord<ChatBootstrap>(value.identity.id, 'settings', 'bootstrap')
    if (!previous || value.revision > previous.revision) {
      set(value.identity.tabId, 'settings', 'bootstrap', value)
      if (!existing || value.revision > (previous?.revision ?? -1)) {
        // Session ids are computer-authoritative once an agent has confirmed them.
        const local = get<ProviderConfigEntry>(value.identity.tabId, 'settings', 'provider')
        set(value.identity.tabId, 'settings', 'provider', {
          ...value.providerConfig,
          ...(local?.chatConversationId ? { chatConversationId: local.chatConversationId } : {})
        })
      }
    }
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
  const queue: ChatQueueData = {
    list: async (tabId) => queued(tabId),
    push: async (tabId, send, original, opts) => {
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
    pop: async (tabId, held = []) => {
      const item = queued(tabId)[0]
      if (!item || held.includes(item.id)) return null
      remove(tabId, 'queue', item.id)
      return item
    },
    update: async (id, next) => {
      const item = queueItem(id)
      if (!item) return false
      set(item.tabId, 'queue', id, { ...item, ...next })
      return true
    },
    move: async (id, toIndex) => {
      const item = queueItem(id)
      if (!item) return false
      const list = queued(item.tabId).filter((i) => i.id !== id)
      list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, item)
      for (let n = 0; n < list.length; n++)
        set(item.tabId, 'queue', list[n].id, { ...list[n], position: n })
      return true
    },
    requeue: async (item) => {
      set(item.tabId, 'queue', item.id, {
        ...item,
        position: (queued(item.tabId)[0]?.position ?? 0) - 1
      })
    },
    remove: async (id) => {
      const item = queueItem(id)
      if (!item) return false
      remove(item.tabId, 'queue', id)
      metadata(item.tabId, 'queue-item', { id, removed: true })
      return true
    },
    clear: async (tabId) => {
      const list = queued(tabId)
      for (const item of list) remove(tabId, 'queue', item.id)
      return list.length
    },
    getTabIdForItem: async (id) => queueItem(id)?.tabId ?? null
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
      metadata(thread.id, 'thread-created', { parentTabId: thread.parentTabId, mode: thread.mode })
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
    getModeDefaultFlags: async (mode) => {
      const tab = store
        .findRecords('settings')
        .find((r) => r.id === 'bootstrap' && (r.value as ChatBootstrap).identity.mode === mode)
      return (tab?.value as ChatBootstrap | undefined)?.defaultFlags ?? null
    },
    recordConversation: async (input) => {
      const tabId = taskTab(input.taskId, input.mode)
      set(tabId, 'settings', `session:${input.conversationId ?? 'reset'}`, input)
      await patch(input.taskId, input.mode, 'chatConversationId', input.conversationId)
      metadata(tabId, 'conversation', input)
    },
    isHonoredConversation: async (t, m, id) =>
      Boolean(get(taskTab(t, m), 'settings', `session:${id}`)) ||
      provider(t, m).chatConversationId === id,
    getCurrentConversationId: async (t, m) => provider(t, m).chatConversationId ?? null,
    bumpLastInteraction: async (taskId, now) => {
      metadata(taskTab(taskId), 'activity', { at: now })
      return true
    },
    persistChatEventSync: (tabId, seq, event, at) => {
      const i = owner(tabId)
      return store.appendAt(i.id, i.epoch, seq, event, at)
    },
    persistChatEvent: async (tabId, seq, event, at) =>
      data.persistChatEventSync!(tabId, seq, event, at ?? Date.now()),
    loadChatEvents: async (tabId) => store.read(owner(tabId).id, -1),
    loadChatEventsRange: async (tabId, after, before) => store.read(owner(tabId).id, after, before),
    getNextSeqForTab: async (tabId) => (store.read(owner(tabId).id, -1).at(-1)?.seq ?? -1) + 1,
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
    saveTimeline: async (tabId, write: TimelineWrite) => {
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
    },
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
  return { data, queue, bootstrap, owner, get, set, remove, metadata }
}
