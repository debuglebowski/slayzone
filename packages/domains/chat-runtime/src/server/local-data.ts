import { randomUUID } from 'node:crypto'
import type {
  ChatDataOps,
  ChatQueueData,
  ChatQueueAdmissions,
  ChatQueuePushOptions,
  QueueAdmission,
  ProviderConfigEntry,
  TimelineWrite,
  ChatThreadStore,
  ChatPinnedMessageStore
} from '@slayzone/terminal/runtime'
import type {
  ChatDraft,
  ChatScrollAnchor,
  ChatTabState,
  ChatThread,
  ChatPinnedMessage,
  QueuedChatMessage,
  UserContentBlock,
  ChatAttachment,
  CliCommandList,
  CliCommandDetails,
  ChatModelInfo
} from '@slayzone/terminal-contracts'
import {
  assertChatTabStateScope,
  userMessageAttachments,
  isSyntheticChatPrompt,
  chatCapabilitiesForMode,
  defaultChatModeSettingKey,
  resolveDefaultChatMode
} from '@slayzone/terminal-contracts'
import type { ChatRecordKind, ConversationIdentity } from '../shared'
import { chatStorageDigest, type ChatStorage } from './storage'
import { trimLocalPromptHistory } from './prompts'
import { chatStorageMode, isStorageOnlyChatOwner, terminalStorageAgentId } from './storage-mode'

export const sessionRecordKey = (mode: string, conversationId: string | null): string =>
  `session:${JSON.stringify([mode, conversationId])}`

export interface ChatBootstrap {
  identity: ConversationIdentity
  projectId: string | null
  cwd: string
  revision: number
  providerConfig: ProviderConfigEntry
  providerConfigRevision?: number
  defaultFlags: string | null
  settings?: Record<string, string | null>
  env: Record<string, string>
  terminalProviderConfig?: ProviderConfigEntry
  terminalProviderConfigRevision?: number
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
  /**
   * The task's metadata state version once this update's writes are done (see
   * `task_state_versions`). Absent from older computers.
   */
  stateVersion?: number
}

export interface ChatMetadataSnapshot {
  identity: ConversationIdentity
  counter: number
  updates: ChatMetadataUpdate[]
  /** Task state version read before the snapshot's content: never newer than it. */
  stateVersion?: number
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
          r.state === 'active' &&
          !store.getRecord(r.identity.id, 'settings', 'inbox') &&
          (!mode || r.identity.mode === chatStorageMode(mode))
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
      // State writes first: the update reports the state version they produce.
      if (kind === 'activity' || kind === 'agent-state' || kind === 'thread-created')
        set(tabId, 'settings', `metadata-state:${kind}`, value)
      const update: ChatMetadataUpdate = {
        operationId,
        sequence,
        conversationId: i.id,
        taskId: i.taskId,
        tabId,
        epoch: i.epoch,
        kind,
        value,
        stateVersion: store.stateVersion(i.taskId)
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
    })
  }
  function providerState(
    taskId: string,
    mode: string
  ): { value: ProviderConfigEntry; revision: number } {
    return store.transaction(() =>
      store.compose((db) => {
        const current = db
          .prepare('SELECT value,revision FROM provider_configs WHERE task_id=? AND mode=?')
          .get(taskId, mode) as { value: string; revision: number } | undefined
        if (current) return { ...current, value: JSON.parse(current.value) as ProviderConfigEntry }
        const tabId = taskTab(taskId, mode),
          key = owner(tabId).mode === mode ? 'provider' : `provider:${mode}`
        // Upgrade old per-tab caches once. Active edits carry the newest saved_at;
        // a prepared sibling is never eligible to become task configuration.
        const candidates = store
          .findRecords('settings', taskId, { id: key })
          .filter((r) => {
            const o = store.conversation(r.conversationId)
            return (
              o?.state === 'active' &&
              o.identity.mode === chatStorageMode(mode) &&
              !store.getRecord(o.identity.id, 'settings', 'inbox')
            )
          })
          .sort(
            (a, b) =>
              b.at - a.at ||
              Number(b.conversationId === owner(tabId).id) -
                Number(a.conversationId === owner(tabId).id)
          )
        const value = (candidates[0]?.value as ProviderConfigEntry | undefined) ?? {}
        db.prepare('INSERT INTO provider_configs VALUES(?,?,0,?)').run(
          taskId,
          mode,
          JSON.stringify(value)
        )
        return { value, revision: 0 }
      })
    )
  }
  function provider(taskId: string, mode: string): ProviderConfigEntry {
    return providerState(taskId, mode).value
  }
  function bootstrapProvider(
    value: ChatBootstrap,
    mode: string,
    config: ProviderConfigEntry,
    revision?: number
  ) {
    const current = providerState(value.identity.taskId, mode)
    if (revision === undefined || revision <= current.revision) return
    const localSession = current.value.chatConversationId
    const next = {
      ...config,
      ...(localSession && !deleted(value.identity.taskId, mode, localSession)
        ? { chatConversationId: localSession }
        : {})
    }
    store.compose((db) =>
      db
        .prepare('UPDATE provider_configs SET value=?,revision=? WHERE task_id=? AND mode=?')
        .run(JSON.stringify(next), revision, value.identity.taskId, mode)
    )
  }
  function patchSync(taskId: string, mode: string, key: keyof ProviderConfigEntry, value: unknown) {
    store.transaction(() => {
      const tabId = taskTab(taskId, mode),
        current = providerState(taskId, mode),
        next = { ...current.value, [key]: value },
        revision = current.revision + 1
      store.compose((db) =>
        db
          .prepare('UPDATE provider_configs SET value=?,revision=? WHERE task_id=? AND mode=?')
          .run(JSON.stringify(next), revision, taskId, mode)
      )
      set(tabId, 'settings', owner(tabId).mode === mode ? 'provider' : `provider:${mode}`, next)
      metadata(tabId, 'provider-config', { mode, key, value, revision })
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
        .findRecords('settings', taskId, { id: 'deleted-sessions' })
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
    return store.transaction(() => {
      // Elect old computer-authoritative caches before this bootstrap can refresh
      // a stale sibling's timestamp (including when the sibling is newly created).
      for (const mode of [
        value.identity.mode,
        ...(value.terminalProviderConfig ? [terminalStorageAgentId(value.identity.mode)] : [])
      ]) {
        const present = store.compose((db) =>
          db
            .prepare('SELECT 1 FROM provider_configs WHERE task_id=? AND mode=?')
            .get(value.identity.taskId, mode)
        )
        if (present) continue
        const key = mode === chatStorageMode(mode) ? 'provider' : `provider:${mode}`
        if (
          store.findRecords('settings', value.identity.taskId, { id: key }).some((r) => {
            const o = store.conversation(r.conversationId)
            return (
              o?.state === 'active' &&
              o.identity.mode === chatStorageMode(mode) &&
              !store.getRecord(o.identity.id, 'settings', 'inbox')
            )
          })
        )
          providerState(value.identity.taskId, mode)
      }
      const existing = store.conversation(value.identity.id)
      store.createConversation(value.identity)
      if (!existing) {
        const inherited = store
          .findRecords('draft', value.identity.taskId, { idPrefix: 'transition:' })
          .find(
            (r) =>
              (r.value as { targetConversationId?: string }).targetConversationId ===
              value.identity.id
          )
        if (inherited) {
          const { targetConversationId: _target, ...state } = inherited.value as ChatTabState & {
            targetConversationId: string
          }
          set(value.identity.tabId, 'draft', 'state', state)
          const previous = store.conversation(inherited.conversationId)!
          store.removeRecord(previous.identity.id, previous.identity.epoch, 'draft', inherited.id)
        }
      }
      if (isStorageOnlyChatOwner(value.identity))
        set(value.identity.tabId, 'settings', 'inbox', true)
      store.transaction(() => {
        const previous =
          get<Array<{ mode: string; conversationId: string }>>(
            value.identity.tabId,
            'settings',
            'deleted-sessions'
          ) ?? []
        const all = new Map(previous.map((v) => [`${v.mode}:${v.conversationId}`, v]))
        for (const v of value.deletedConversations ?? [])
          all.set(`${v.mode}:${v.conversationId}`, v)
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
        const mode = terminalStorageAgentId(value.identity.mode)
        if (!previous || value.revision > previous.revision)
          set(value.identity.tabId, 'settings', `provider:${mode}`, value.terminalProviderConfig)
      }
      if (!get(value.identity.tabId, 'settings', 'inbox'))
        store.transaction(() => {
          bootstrapProvider(
            value,
            value.identity.mode,
            value.providerConfig,
            value.providerConfigRevision
          )
          if (value.terminalProviderConfig)
            bootstrapProvider(
              value,
              terminalStorageAgentId(value.identity.mode),
              value.terminalProviderConfig,
              value.terminalProviderConfigRevision
            )
        })
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
    })
  }
  const queued = (tabId: string): QueuedChatMessage[] =>
    store
      .records(owner(tabId).id, 'queue')
      .map((r) => r.value as QueuedChatMessage)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  function queueItem(id: string) {
    const r = store.findRecords('queue').find((r) => r.id === id)
    return r ? (r.value as QueuedChatMessage) : null
  }
  type SyncQueueData = {
    [K in keyof Required<ChatQueueData>]: (
      ...args: Parameters<NonNullable<ChatQueueData[K]>>
    ) => Awaited<ReturnType<NonNullable<ChatQueueData[K]>>>
  }
  type QueueMessageIdentity = {
    inputHash?: string
    unsealedInputHash?: string
    messageHash: string
    position: number
    createdAt: string
    // Only version identities persist here, never user text or attachment names.
    seals?: Record<string, string>
    handedOff?: boolean
  }
  const queueMessagePrefix = 'queue-message:'
  const queueMessageKey = (id: string) => queueMessagePrefix + id
  const messageContent = (send: string, content?: UserContentBlock[]) =>
    content ?? [{ type: 'text' as const, text: send }]
  const unsealedContent = (content?: UserContentBlock[]) =>
    content?.map((block) => {
      if (block.type !== 'attachment') return block
      const { contentHash: _hash, ...attachment } = block.attachment
      return { ...block, attachment }
    })
  function sameQueueMessage(item: QueuedChatMessage, sent: UserContentBlock[]) {
    const queued = messageContent(item.send, item.content).map((block, index) => {
      const accepted = sent[index]
      return block.type === 'attachment' &&
        !block.attachment.contentHash &&
        accepted?.type === 'attachment' &&
        accepted.attachment.contentHash
        ? {
            ...block,
            attachment: { ...block.attachment, contentHash: accepted.attachment.contentHash }
          }
        : block
    })
    return chatStorageDigest(queued) === chatStorageDigest(sent)
  }
  function queueInputHash(send: string, original: string, opts?: ChatQueuePushOptions) {
    return chatStorageDigest({
      send,
      original,
      content: opts?.submittedContent ?? opts?.content ?? null,
      expectedConversationId: opts?.expectedConversationId ?? null
    })
  }
  function queueIdentity(
    item: QueuedChatMessage,
    inputHash?: string,
    legacy = false
  ): QueueMessageIdentity {
    const seals: Record<string, string> = {}
    item.content?.forEach((block, index) => {
      if (block.type === 'attachment' && block.attachment.contentHash)
        seals[index] = block.attachment.contentHash
    })
    return {
      inputHash: inputHash ?? queueInputHash(item.send, item.original, item),
      ...(legacy
        ? {
            unsealedInputHash: queueInputHash(item.send, item.original, {
              ...item,
              content: unsealedContent(item.content)
            })
          }
        : {}),
      messageHash: chatStorageDigest(messageContent(item.send, item.content)),
      position: item.position,
      createdAt: item.createdAt,
      ...(Object.keys(seals).length ? { seals } : {})
    }
  }
  function recordQueueHandoff(tabId: string, id: string, content: UserContentBlock[], at: number) {
    const key = queueMessageKey(id),
      previous = get<QueueMessageIdentity>(tabId, 'settings', key),
      item = store.getRecord<QueuedChatMessage>(owner(tabId).id, 'queue', id),
      messageHash = chatStorageDigest(content)
    if (item && !sameQueueMessage(item, content))
      throw new Error('Queue message id conflicts with accepted history')
    set(tabId, 'settings', key, {
      ...(previous ??
        (item ? queueIdentity(item) : { position: 0, createdAt: new Date(at).toISOString() })),
      messageHash,
      handedOff: true
    } satisfies QueueMessageIdentity)
  }
  function repairQueueIdentities(tabId: string) {
    if (get(tabId, 'settings', 'queue-message-identities-v5')) return
    store.transaction(() => {
      const i = owner(tabId)
      // Pre-fix operation receipts can recover the original enqueue fingerprint,
      // including raw command text that is absent from the user-message event.
      store.compose((db) => {
        let cursor = 0
        for (;;) {
          const rows = db
            .prepare(`SELECT rowid AS cursor,result FROM receipts WHERE conversation_id=?
            AND state='delivered' AND result_expired=0 AND rowid>? ORDER BY rowid LIMIT 256`)
            .all(i.id, cursor) as Array<{ cursor: number; result: string }>
          for (const row of rows) {
            cursor = row.cursor
            const item = JSON.parse(row.result) as Partial<QueuedChatMessage> | null
            if (
              !item ||
              typeof item.id !== 'string' ||
              typeof item.send !== 'string' ||
              typeof item.original !== 'string' ||
              typeof item.createdAt !== 'string' ||
              typeof item.position !== 'number'
            )
              continue
            const key = queueMessageKey(item.id)
            if (!get(tabId, 'settings', key))
              set(tabId, 'settings', key, queueIdentity(item as QueuedChatMessage, undefined, true))
          }
          if (rows.length < 256) break
        }
      })
      for (const record of store.records(i.id, 'queue')) {
        const item = record.value as QueuedChatMessage,
          key = queueMessageKey(item.id)
        if (!get(tabId, 'settings', key))
          set(tabId, 'settings', key, queueIdentity(item, undefined, true))
      }
      store.compose((db) => {
        let cursor = -1
        for (;;) {
          const rows = db
            .prepare(`SELECT seq,saved_at,event FROM events WHERE conversation_id=?
            AND seq>? AND json_extract(event,'$.kind')='user-message' AND COALESCE(json_extract(event,'$.history'),0)=0
            ORDER BY seq LIMIT 256`)
            .all(i.id, cursor) as Array<{ seq: number; saved_at: number; event: string }>
          for (const row of rows) {
            cursor = row.seq
            const event = JSON.parse(row.event) as Extract<
              import('@slayzone/terminal-contracts').AgentEvent,
              { kind: 'user-message' }
            >
            if (!event.id) continue
            const content = messageContent(event.text, event.content),
              item = store.getRecord<QueuedChatMessage>(i.id, 'queue', event.id)
            if (item && !sameQueueMessage(item, content)) {
              const previous = get<QueueMessageIdentity>(
                tabId,
                'settings',
                queueMessageKey(event.id)
              )!
              set(tabId, 'settings', queueMessageKey(event.id), {
                ...previous,
                messageHash: chatStorageDigest(content),
                handedOff: true
              })
              continue // Preserve an unprovable conflicting row for explicit recovery.
            }
            recordQueueHandoff(tabId, event.id, content, row.saved_at)
            if (item) {
              remove(tabId, 'queue', item.id)
              metadata(tabId, 'queue-item', { id: item.id, removed: true })
            }
          }
          if (rows.length < 256) break
        }
      })
      set(tabId, 'settings', 'queue-message-identities-v5', true)
    })
  }
  function replayQueueMessage(
    tabId: string,
    send: string,
    original: string,
    opts: ChatQueuePushOptions
  ): QueuedChatMessage | null {
    const current = owner(tabId)
    // The same logical tab can acquire a new provider/storage owner. Initialize
    // historical siblings before choosing a task-wide client message identity.
    for (const sibling of store.listForTask(current.taskId))
      if (sibling.state === 'active') repairQueueIdentities(sibling.identity.tabId)
    if (!opts.id) return null
    const accepted = store.queueMessageIdentity<QueueMessageIdentity>(current.taskId, opts.id)
    if (!accepted) return null
    const saved = accepted.value
    const content = (opts.submittedContent ?? opts.content)?.map((block, index) =>
      block.type === 'attachment' && saved.seals?.[index]
        ? { ...block, attachment: { ...block.attachment, contentHash: saved.seals[index] } }
        : block
    )
    const inputHash = queueInputHash(send, original, opts)
    const legacyEquivalent =
      saved.unsealedInputHash ===
        queueInputHash(send, original, {
          ...opts,
          submittedContent: undefined,
          content: unsealedContent(opts.submittedContent ?? opts.content)
        }) &&
      (opts.submittedContent ?? opts.content ?? []).every(
        (block, index) =>
          block.type !== 'attachment' ||
          !block.attachment.contentHash ||
          block.attachment.contentHash === saved.seals?.[index]
      )
    if (
      saved.inputHash
        ? saved.inputHash !== inputHash && !legacyEquivalent
        : saved.messageHash !== chatStorageDigest(messageContent(send, content))
    )
      throw new Error('Queue message id reused with different input')
    if (accepted.conversationId !== current.id) {
      const source = store.conversation(accepted.conversationId)
      throw new Error(
        source?.state === 'deleted'
          ? 'Message already accepted in a previous chat that was deleted; retry will not send it again'
          : 'Message already accepted in a previous chat; its local copy is retained there'
      )
    }
    if (!saved.inputHash) set(tabId, 'settings', queueMessageKey(opts.id), { ...saved, inputHash })
    if (opts.admission) {
      const reservation = get<AdmissionRecord>(
        tabId,
        'settings',
        admissionPrefix + opts.admission.key
      )
      if (reservation?.token === opts.admission.token && reservation.id === opts.id)
        remove(tabId, 'settings', admissionPrefix + opts.admission.key)
    }
    return {
      id: opts.id,
      tabId,
      send,
      original,
      position: saved.position,
      createdAt: saved.createdAt,
      ...(content ? { content } : {}),
      ...(opts.expectedConversationId
        ? { expectedConversationId: opts.expectedConversationId }
        : {})
    }
  }
  type AdmissionRecord = QueueAdmission & {
    id: string
    inputHash?: string
    position: number
    state: 'pending' | 'cancelled'
  }
  const admissionPrefix = 'queue-admission:'
  function queueAdmissions(tabId: string): AdmissionRecord[] {
    return store.compose((db) =>
      (
        db
          .prepare(
            "SELECT value FROM records WHERE conversation_id=? AND kind='settings' AND id>=? AND id<?"
          )
          .all(owner(tabId).id, admissionPrefix, admissionPrefix + '\uffff') as Array<{
          value: string
        }>
      ).map((r) => JSON.parse(r.value) as AdmissionRecord)
    )
  }
  function pendingAdmissions(tabId: string): AdmissionRecord[] {
    const pending: AdmissionRecord[] = []
    for (const reservation of queueAdmissions(tabId)) {
      if (reservation.state !== 'pending') continue
      if (reservation.expiresAt <= Date.now())
        remove(tabId, 'settings', admissionPrefix + reservation.key)
      else pending.push(reservation)
    }
    return pending
  }
  function requireAdmission(
    tabId: string,
    value: Pick<QueueAdmission, 'key' | 'token'>
  ): AdmissionRecord {
    const found = get<AdmissionRecord>(tabId, 'settings', admissionPrefix + value.key)
    if (
      !found ||
      found.token !== value.token ||
      found.state !== 'pending' ||
      found.expiresAt <= Date.now()
    )
      throw new Error('Queue admission was cancelled or expired; submit the message again')
    return found
  }
  const reserveQueue: ChatQueueAdmissions['reserve'] = atomic((tabId, id, key, inputHash) => {
    repairQueueIdentities(tabId)
    const old = get<AdmissionRecord>(tabId, 'settings', admissionPrefix + key)
    if (old) {
      const current = requireAdmission(tabId, old)
      if (current.id !== id || current.inputHash !== inputHash)
        throw new Error('Queue admission id conflict')
      return current
    }
    const previous = queueItem(id)
    if (previous && previous.tabId !== tabId) throw new Error('Queue operation id conflict')
    const position =
      [...queued(tabId), ...pendingAdmissions(tabId)].reduce(
        (n, item) => Math.max(n, item.position),
        -1
      ) + 1
    const reservation: AdmissionRecord = {
      id,
      ...(inputHash ? { inputHash } : {}),
      key,
      token: randomUUID(),
      position,
      state: 'pending',
      expiresAt: Date.now() + 120_000
    }
    set(tabId, 'settings', admissionPrefix + key, reservation)
    return reservation
  })
  const renewQueue: ChatQueueAdmissions['renewReservation'] = atomic((tabId, value) => {
    const reservation = requireAdmission(tabId, value)
    const next = { ...reservation, expiresAt: Date.now() + 120_000 }
    set(tabId, 'settings', admissionPrefix + value.key, next)
    return next
  })
  const cancelQueue: ChatQueueAdmissions['cancelReservation'] = atomic((tabId, value) => {
    const reservation = get<AdmissionRecord>(tabId, 'settings', admissionPrefix + value.key)
    if (!reservation) return
    if (reservation.token !== value.token) throw new Error('Queue admission token mismatch')
    remove(tabId, 'settings', admissionPrefix + value.key)
  })
  function cancelPendingQueueAdmissions() {
    store.transaction(() => {
      for (const record of store.findRecords('settings', undefined, {
        idPrefix: admissionPrefix
      })) {
        const value = record.value as AdmissionRecord
        if (value.state !== 'pending') continue
        const conversation = store.conversation(record.conversationId)
        if (conversation?.state !== 'active') continue
        store.removeRecord(
          record.conversationId,
          conversation.identity.epoch,
          'settings',
          record.id
        )
      }
    })
  }
  const queueSync: SyncQueueData = {
    list: (tabId) => {
      repairQueueIdentities(tabId)
      return queued(tabId)
    },
    replay: replayQueueMessage,
    push: (tabId, send, original, opts) => {
      const id = opts?.id ?? randomUUID(),
        previous = queueItem(id)
      const replay = replayQueueMessage(tabId, send, original, { ...opts, id })
      if (replay) return replay
      if (previous) {
        if (
          previous.tabId !== tabId ||
          previous.send !== send ||
          previous.original !== original ||
          previous.expectedConversationId !== opts?.expectedConversationId ||
          JSON.stringify(previous.content) !== JSON.stringify(opts?.content)
        )
          throw new Error('Queue operation id conflict')
        if (opts?.admission) {
          const reservation = requireAdmission(tabId, opts.admission)
          if (reservation.id !== id) throw new Error('Queue admission id conflict')
          remove(tabId, 'settings', admissionPrefix + reservation.key)
        }
        return previous
      }
      const reservation = opts?.admission ? requireAdmission(tabId, opts.admission) : null
      if (reservation && reservation.id !== id) throw new Error('Queue admission id conflict')
      const list = queued(tabId)
      const item: QueuedChatMessage = {
        id,
        tabId,
        send,
        original,
        position:
          reservation?.position ??
          pendingAdmissions(tabId).reduce(
            (n, item) => Math.max(n, item.position),
            list.at(-1)?.position ?? -1
          ) + 1,
        createdAt: new Date().toISOString(),
        ...(opts?.content ? { content: opts.content } : {}),
        ...(opts?.expectedConversationId
          ? { expectedConversationId: opts.expectedConversationId }
          : {})
      }
      set(tabId, 'queue', id, item)
      set(
        tabId,
        'settings',
        queueMessageKey(id),
        queueIdentity(item, queueInputHash(send, original, opts))
      )
      if (reservation) remove(tabId, 'settings', admissionPrefix + reservation.key)
      metadata(tabId, 'queue-item', { id, removed: false })
      return item
    },
    pop: (tabId, held = []) => {
      repairQueueIdentities(tabId)
      const item = queued(tabId)[0]
      const accepted =
        item && get<QueueMessageIdentity>(tabId, 'settings', queueMessageKey(item.id))
      if (
        accepted?.handedOff &&
        accepted.messageHash !== chatStorageDigest(messageContent(item!.send, item!.content))
      )
        throw new Error(
          'Queue message id conflicts with accepted history; enqueue it with a new id'
        )
      if (
        !item ||
        held.includes(item.id) ||
        pendingAdmissions(tabId).some((r) => r.position <= item.position)
      )
        return null
      // Keep the row until its user-message event commits in the same transaction.
      return item
    },
    update: (id, next) => {
      const item = queueItem(id)
      if (!item) return false
      repairQueueIdentities(item.tabId)
      set(item.tabId, 'queue', id, { ...item, ...next })
      return true
    },
    move: (id, toIndex) => {
      const item = queueItem(id)
      if (!item) return false
      repairQueueIdentities(item.tabId)
      if (pendingAdmissions(item.tabId).length) return false
      const list = queued(item.tabId).filter((i) => i.id !== id)
      list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, item)
      for (let n = 0; n < list.length; n++)
        set(item.tabId, 'queue', list[n].id, { ...list[n], position: n })
      return true
    },
    requeue: (item) => {
      repairQueueIdentities(item.tabId)
      // Computer pops retain the row until durable event handoff. A late
      // failure must not recreate a row cleared/expired during async dispatch.
      if (!queueItem(item.id)) return
      set(item.tabId, 'queue', item.id, {
        ...item,
        position: (queued(item.tabId)[0]?.position ?? 0) - 1
      })
    },
    remove: (id) => {
      const item = queueItem(id)
      if (!item) return false
      repairQueueIdentities(item.tabId)
      remove(item.tabId, 'queue', id)
      metadata(item.tabId, 'queue-item', { id, removed: true })
      return true
    },
    clear: (tabId) => {
      repairQueueIdentities(tabId)
      for (const r of pendingAdmissions(tabId)) remove(tabId, 'settings', admissionPrefix + r.key)
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
  const queue: ChatQueueData & ChatQueueAdmissions = {
    reserve: reserveQueue,
    renewReservation: renewQueue,
    cancelReservation: cancelQueue,
    list: atomic(queueSync.list),
    replay: atomic(queueSync.replay),
    push: atomic(queueSync.push),
    pop: atomic(queueSync.pop),
    update: atomic(queueSync.update),
    move: atomic(queueSync.move),
    requeue: atomic(queueSync.requeue),
    remove: atomic(queueSync.remove),
    clear: atomic(queueSync.clear),
    getTabIdForItem: atomic(queueSync.getTabIdForItem)
  }
  // A thread stored before closing existed has no `closedAt`: it is open.
  type StoredThread = Omit<ChatThread, 'closedAt'> & { closedAt?: number | null }
  const readThread = (value: StoredThread): ChatThread => ({
    ...value,
    closedAt: value.closedAt ?? null
  })
  const maybeThread = (value: StoredThread | undefined): ChatThread | undefined =>
    value && readThread(value)
  const threads: ChatThreadStore = {
    get: async (id) =>
      maybeThread(
        store.findRecords('thread', undefined, { id }).find((r) => {
          const parent = store.conversation(r.conversationId)
          return parent?.state === 'active' && !store.isTabDeleted(parent.identity.taskId, id)
        })?.value as StoredThread | undefined
      ),
    listForParent: async (tabId) =>
      store
        .records(owner(tabId).id, 'thread')
        .map((r) => readThread(r.value as StoredThread))
        .filter((thread) => !store.isTabDeleted(owner(tabId).taskId, thread.id))
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
    },
    setClosed: async (id, closedAt) => {
      const thread = await threads.get(id)
      if (thread) set(thread.parentTabId, 'thread', id, { ...thread, closedAt })
    }
  }
  // A pin's record: one per row of one provider conversation of the tab.
  const pinRecordId = (conversationId: string, key: string): string =>
    JSON.stringify([conversationId, key])
  const pinnedMessages: ChatPinnedMessageStore = {
    list: async (tabId, conversationId) =>
      store
        .records(owner(tabId).id, 'pinned-message')
        .map((r) => r.value as ChatPinnedMessage)
        .filter((pin) => pin.conversationId === conversationId)
        .sort((a, b) => a.pinnedAt - b.pinnedAt || a.key.localeCompare(b.key)),
    pin: async (tabId, pin) =>
      set(tabId, 'pinned-message', pinRecordId(pin.conversationId, pin.key), pin),
    unpin: async (tabId, conversationId, key) =>
      remove(tabId, 'pinned-message', pinRecordId(conversationId, key))
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
    pinnedMessages,
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
        .findRecords('settings', undefined, { id: 'bootstrap' })
        .find((r) => r.id === 'bootstrap' && (r.value as ChatBootstrap).identity.mode === mode)
      return (tab?.value as ChatBootstrap | undefined)?.defaultFlags ?? null
    },
    recordConversation: async (input) => {
      store.transaction(() => {
        const tabId = taskTab(input.taskId, input.mode)
        const value = { ...input, createdAt: input.createdAt ?? Date.now() }
        set(tabId, 'settings', sessionRecordKey(input.mode, input.conversationId), value)
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
        session =
          get<{ mode?: string }>(tabId, 'settings', sessionRecordKey(m, id)) ??
          get<{ mode?: string }>(tabId, 'settings', `session:${id}`)
      return (
        Boolean(get(tabId, 'settings', `session-proof:${m}:${id}`)) ||
        Boolean(session && (session.mode ?? owner(tabId).mode) === m) ||
        [provider(t, m).chatConversationId, provider(t, m).conversationId].includes(id)
      )
    },
    getCurrentConversationId: async (t, m) => {
      const id =
        (chatStorageMode(m) !== m
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
        if (outcome === 'inserted' && event.kind === 'user-message' && !event.history && event.id)
          recordQueueHandoff(tabId, event.id, messageContent(event.text, event.content), at)
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
      for (const r of store.findRecords('settings', taskId, { idPrefix: 'attachment-message:' }))
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
        .records(owner(tabId).id, 'timeline')
        .filter((r) => r.kind === 'timeline' && r.id.startsWith('page:'))
        .map((r) => ({
          page: Number(r.id.slice(5)),
          summary: (r.value as { summary: string }).summary
        }))
        .sort((a, b) => a.page - b.page),
    saveTimeline: async (tabId, write: TimelineWrite) =>
      store.transaction(() => {
        if (write.dropPagesFrom !== null)
          for (const r of store.records(owner(tabId).id, 'timeline'))
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
        .records(owner(tabId).id, 'timeline')
        .filter(
          (r) =>
            r.kind === 'timeline' &&
            r.id.startsWith('page:') &&
            (r.value as { searchText: string }).searchText.includes(needle)
        )
        .map((r) => Number(r.id.slice(5)))
        .sort((a, b) => a - b),
    clearTimeline: async (tabId) => {
      for (const r of store.records(owner(tabId).id, 'timeline'))
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
      const tabId = store
        .findRecords('settings', undefined, { id: 'bootstrap' })
        .find((r) => store.conversation(r.conversationId)?.state === 'active')?.value as
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
      for (const r of store.findRecords('settings', undefined, { idPrefix: 'usage:' }))
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
    getTabState: async (tabId, scope) => {
      const identity = owner(tabId)
      assertChatTabStateScope(identity, scope)
      const state = get<ChatTabState>(tabId, 'draft', 'state')
      return scope
        ? {
            ...(state ?? { draft: { text: '', attachments: [], rev: 0 }, scroll: null }),
            ownership: { id: identity.id, epoch: identity.epoch }
          }
        : state
    },
    saveTabDraft: async (tabId, draft: ChatDraft, scope) =>
      store.transaction(() => {
        assertChatTabStateScope(owner(tabId), scope)
        const state = get<ChatTabState>(tabId, 'draft', 'state')
        const rev = (state?.draft.rev ?? 0) + 1
        set(tabId, 'draft', 'state', { draft: { ...draft, rev }, scroll: state?.scroll ?? null })
        return { rev }
      }),
    saveTabScroll: async (tabId, anchor: ChatScrollAnchor, scope) =>
      store.transaction(() => {
        assertChatTabStateScope(owner(tabId), scope)
        const state = get<ChatTabState>(tabId, 'draft', 'state')
        set(tabId, 'draft', 'state', {
          draft: state?.draft ?? { text: '', attachments: [], rev: 0 },
          scroll: anchor
        })
      }),
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
      const stateVersion = store.stateVersion(o.identity.taskId)
      const i = o.identity,
        records = store.compose((db) =>
          (
            db
              .prepare(`SELECT kind,id,value,saved_at FROM records
          WHERE conversation_id=? AND (kind='queue' OR (kind='settings' AND
            (id='provider' OR id GLOB 'provider:*' OR id GLOB 'session:*' OR
             id IN ('metadata-state:activity','metadata-state:agent-state'))))
          ORDER BY kind,id`)
              .all(id) as Array<{
              kind: ChatRecordKind
              id: string
              value: string
              saved_at: number
            }>
          ).map((r) => ({ kind: r.kind, id: r.id, value: JSON.parse(r.value), at: r.saved_at }))
        ),
        counter = store.getRecord<number>(id, 'settings', 'metadata-counter') ?? 0
      const updates: ChatMetadataUpdate[] = []
      if (i.tabId.startsWith('artifact-store:'))
        return { identity: i, counter, updates, stateVersion }
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
            ownershipClaim?: boolean
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
              ...(v.ownershipClaim !== undefined ? { ownershipClaim: v.ownershipClaim } : {}),
              legacyJsonField: (v.mode ?? i.mode).endsWith('-chat')
                ? 'chatConversationId'
                : 'conversationId'
            })
        }
        if (
          !isStorageOnlyChatOwner(i) &&
          r.kind === 'settings' &&
          (r.id === 'provider' || r.id.startsWith('provider:'))
        ) {
          const mode = r.id === 'provider' ? i.mode : r.id.slice(9),
            current = providerState(i.taskId, mode),
            cfg = current.value
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
                revision: current.revision,
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
      return { identity: i, counter, updates, stateVersion }
    })
  }
  return {
    data,
    queue,
    bootstrap,
    owner,
    get,
    set,
    remove,
    metadata,
    metadataSnapshot,
    cancelPendingQueueAdmissions,
    repairQueueIdentities
  }
}
