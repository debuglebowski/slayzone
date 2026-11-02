import { randomUUID } from 'node:crypto'
import { TypedEmitter } from '@slayzone/platform/events'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  chatModeForTerminal,
  type AgentEvent,
  type ChatSessionStateEntry
} from '@slayzone/terminal-contracts'
import {
  supportsChatMode,
  type ChatTerminalState,
  type ChatDeps,
  type ChatEventMap,
  type ChatQueueEventMap,
  type ChatCatalog,
  type ChatCatalogOperation,
  type ChatCatalogContext
} from '@slayzone/terminal/runtime'
import {
  chatOperationSchemas,
  chatQueueOperationSchemas,
  CHAT_READ_OPERATIONS,
  type ChatOperation,
  type ChatQueueOperation
} from '../shared'
import type { ChatBootstrap, ChatMetadataUpdate, ChatMetadataSnapshot } from './local-data'
import type { ChatOwnershipStore, HubChatOwnership } from './hub-ownership'
import type { ChatComputerRequest } from './migration'

const trimUnsetArgs = (args: unknown[]) => {
  let end = args.length
  while (end && args[end - 1] === undefined) end--
  return args.slice(0, end)
}

type TabRow = { id: string; task_id: string; mode: string }
const taskMethods = new Set([
  'inspectPermissions',
  'getMode',
  'getModel',
  'getEffort',
  'getCollaboration',
  'getFastMode',
  'getModels',
  'getCliSnapshot',
  'getCliCommandDetails'
])
const catalogMethods = new Set([
  'getAutoEligibility',
  'listSkills',
  'listCommands',
  'listAgents',
  'listFiles',
  'bumpAutocompleteUsage',
  'getAutocompleteUsage'
])

/** Metadata routing only. This facade never instantiates a chat process or content store. */
export function createHubChatRelay(opts: {
  db: SlayzoneDb
  ownership: ChatOwnershipStore
  request: ChatComputerRequest
  hasLegacyTaskContent?(taskId: string): Promise<boolean>
  resolveMigrationComputer?(owner: HubChatOwnership): Promise<string | null>
  resolveComputer(taskId: string): Promise<string | null>
  defaultComputer(): Promise<string | null>
  gate?(computerId: string, taskId: string): Promise<void>
  recoverComputer?(computerId: string): Promise<void>
  bootstrap(owner: HubChatOwnership): Promise<ChatBootstrap>
  migrate(id: string, computerId: string): Promise<HubChatOwnership>
  beforeInvoke?(owner: HubChatOwnership, method: string, args: unknown[]): Promise<void>
  onTasksChanged?(taskId: string): void
  onState?(sessionId: string, state: ChatTerminalState, previous: ChatTerminalState): void
}) {
  const { db, ownership } = opts
  const events = new TypedEmitter<ChatEventMap>(),
    queueEvents = new TypedEmitter<ChatQueueEventMap>()
  const sessionMirror = new Map<
    string,
    ChatSessionStateEntry & { computerId: string; providerSessionId?: string | null }
  >()
  const taskMigrations = new Map<string, Promise<void>>()
  const registrations = new Map<string, Promise<HubChatOwnership>>()
  async function createTab(tab: TabRow) {
    const existing = await ownership.forTab(tab.id)
    if (existing) return existing
    const legacy =
      (await db.get(
        `SELECT 1 WHERE EXISTS(SELECT 1 FROM chat_events WHERE tab_id=?) OR EXISTS(SELECT 1 FROM chat_tab_state WHERE tab_id=?) OR EXISTS(SELECT 1 FROM chat_queue WHERE tab_id=?) OR EXISTS(SELECT 1 FROM chat_threads WHERE id=? OR parent_tab_id=?) OR EXISTS(SELECT 1 FROM chat_workspace_changes WHERE tab_id=?) OR EXISTS(SELECT 1 FROM agent_prompts WHERE task_id=?) OR EXISTS(SELECT 1 FROM chat_cli_snapshots WHERE project_id=(SELECT project_id FROM tasks WHERE id=?) AND mode=?)`,
        [tab.id, tab.id, tab.id, tab.id, tab.id, tab.id, tab.task_id, tab.task_id, tab.mode]
      )) || (await opts.hasLegacyTaskContent?.(tab.task_id))
    const pc = legacy ? null : await opts.resolveComputer(tab.task_id)
    if (!legacy && !pc) throw new Error('Chat computer unavailable. Connect its computer.')
    const value = {
      id: randomUUID(),
      taskId: tab.task_id,
      tabId: tab.id,
      mode: chatModeForTerminal(tab.mode) ?? tab.mode,
      computerId: pc,
      epoch: 1
    }
    if (pc) {
      await opts.gate?.(pc, tab.task_id)
      const provisional: HubChatOwnership = {
        ...value,
        state: 'active',
        migrationId: null,
        destinationComputerId: null,
        sourceComputerId: null,
        manifestHash: null,
        cleanupPending: false,
        settingsRevision: 0,
        settingsHash: null
      }
      // Persist the new store before publishing an active hub locator. Recovery
      // can adopt a computer commit if the hub disappears between these steps.
      await opts.request(pc, { kind: 'bootstrap', value: await opts.bootstrap(provisional) })
    }
    return ownership.register(value)
  }
  function registerTab(tab: TabRow) {
    const running = registrations.get(tab.id)
    if (running) return running
    const work = createTab(tab).finally(() => registrations.delete(tab.id))
    registrations.set(tab.id, work)
    return work
  }
  async function migrateTask(taskId: string) {
    const existing = taskMigrations.get(taskId)
    if (existing) return existing
    const work = (async () => {
      const tabs = await db.all<TabRow>(
        `SELECT id,task_id,mode FROM terminal_tabs WHERE task_id=? AND mode IN ('claude-chat','codex-chat') ORDER BY CASE WHEN EXISTS(SELECT 1 FROM chat_threads WHERE id=terminal_tabs.id) THEN 1 ELSE 0 END,created_at,id`,
        [taskId]
      )
      for (const tab of tabs) await registerTab(tab)
      for (const owner of await ownership.forTask(taskId)) {
        if (owner.state === 'deleted') continue
        if (owner.state === 'active' && !owner.cleanupPending) continue
        const pc =
          owner.destinationComputerId ??
          (await (opts.resolveMigrationComputer
            ? opts.resolveMigrationComputer(owner)
            : opts.resolveComputer(taskId)))
        if (!pc)
          throw new Error('Chat computer unavailable. Connect its computer to migrate history.')
        await opts.gate?.(pc, taskId)
        await opts.migrate(owner.id, pc)
      }
    })().finally(() => {
      taskMigrations.delete(taskId)
    })
    taskMigrations.set(taskId, work)
    return work
  }
  async function ensureTab(tabId: string) {
    let owner = await ownership.forTab(tabId)
    if (opts.recoverComputer) {
      const taskId =
        owner?.taskId ??
        (await db.get<{ task_id: string }>('SELECT task_id FROM terminal_tabs WHERE id=?', [tabId]))
          ?.task_id
      const pc =
        owner?.computerId ??
        owner?.destinationComputerId ??
        (taskId ? await opts.resolveComputer(taskId) : null)
      if (pc) await opts.recoverComputer(pc)
      owner = await ownership.forTab(tabId)
    }
    if (!owner) {
      const tab = await db.get<TabRow>('SELECT id,task_id,mode FROM terminal_tabs WHERE id=?', [
        tabId
      ])
      if (!tab || !supportsChatMode(chatModeForTerminal(tab.mode) ?? tab.mode))
        throw new Error('Unknown chat tab')
      owner = await registerTab(tab)
    }
    if (owner.state === 'deleted') throw new Error('Chat conversation deleted')
    if (owner.state !== 'active' || owner.cleanupPending) {
      await migrateTask(owner.taskId)
      owner = (await ownership.get(owner.id))!
    }
    if (!owner.computerId || owner.state !== 'active')
      throw new Error('Chat history migration is incomplete')
    await opts.gate?.(owner.computerId, owner.taskId)
    return owner
  }
  async function ensureTask(taskId: string, mode?: string) {
    const tabs = await db.all<TabRow>(
      'SELECT id,task_id,mode FROM terminal_tabs WHERE task_id=? ORDER BY position,created_at,id',
      [taskId]
    )
    const tab =
      tabs.find((t) => supportsChatMode(t.mode) && (!mode || t.mode === mode)) ??
      tabs.find((t) => (chatModeForTerminal(t.mode) ?? t.mode) === mode)
    if (!tab) throw new Error('Task has no chat tab for this provider')
    return ensureTab(tab.id)
  }
  async function ensurePromptTask(taskId: string) {
    const pc = await opts.resolveComputer(taskId)
    if (pc) await opts.recoverComputer?.(pc)
    const owners = (await ownership.forTask(taskId)).filter((o) => o.state !== 'deleted')
    if (owners.length) {
      for (const owner of owners)
        if (owner.state !== 'active' || owner.cleanupPending) {
          await migrateTask(taskId)
          break
        }
      return (await ownership.forTask(taskId)).filter((o) => o.state === 'active')
    }
    const computerId = await opts.resolveComputer(taskId)
    if (!computerId) throw new Error('Prompt history computer unavailable')
    await opts.gate?.(computerId, taskId)
    const legacy =
      (await db.get('SELECT 1 FROM agent_prompts WHERE task_id=? LIMIT 1', [taskId])) ||
      (await opts.hasLegacyTaskContent?.(taskId))
    const owner = await ownership.register({
      id: randomUUID(),
      taskId,
      tabId: `prompt-history:${taskId}`,
      mode: 'claude-chat',
      computerId: legacy ? null : computerId,
      epoch: 1
    })
    if (legacy) {
      await migrateTask(taskId)
      return (await ownership.forTask(taskId)).filter((o) => o.state === 'active')
    }
    await sync(owner)
    return [owner]
  }
  async function sync(owner: HubChatOwnership) {
    if (!owner.computerId) throw new Error('Chat computer unavailable')
    await opts.request(owner.computerId, { kind: 'bootstrap', value: await opts.bootstrap(owner) })
  }
  async function route(target: 'ops' | 'queue', method: string, args: unknown[]) {
    const first = args[0]
    if (target === 'queue' && !['list', 'push', 'clear'].includes(method)) {
      const owner = await ownership.forQueueItem(String(first))
      if (!owner) throw new Error('Unknown queued message')
      return ensureTab(owner.tabId)
    }
    if (first && typeof first === 'object' && 'tabId' in first)
      return ensureTab(String(first.tabId))
    if (target === 'ops' && taskMethods.has(method))
      return ensureTask(String(first), String(args[1]))
    return ensureTab(String(first))
  }
  async function applyMetadata(computerId: string, raw: ChatMetadataUpdate, advance = true) {
    const owner = await ownership.get(raw.conversationId)
    // thread-created is the only notification that may introduce a new binding.
    let current = owner
    if (!current && raw.kind === 'thread-created') {
      const value = raw.value as {
        parentTabId: string
        mode: string
        parentConversationId?: string
        answerId?: string
        sourceMessageId?: string
        sourceUuid?: string
        createdAt?: number
      }
      const parent = await ownership.forTab(value.parentTabId)
      if (
        !parent ||
        parent.computerId !== computerId ||
        parent.taskId !== raw.taskId ||
        parent.state !== 'active' ||
        parent.epoch !== raw.epoch
      )
        throw new Error('Thread metadata ownership mismatch')
      await opts.gate?.(computerId, parent.taskId)
      const existingTab = await db.get<{ task_id: string }>(
        'SELECT task_id FROM terminal_tabs WHERE id=?',
        [raw.tabId]
      )
      if (existingTab && existingTab.task_id !== raw.taskId)
        throw new Error('Thread tab belongs to another task')
      await db.run(
        `INSERT INTO terminal_tabs(id,task_id,label,mode,position,group_id) VALUES(?,?,'Thread',?,-1,?) ON CONFLICT(id) DO NOTHING`,
        [raw.tabId, raw.taskId, value.mode, raw.tabId]
      )
      current = await ownership.register({
        id: raw.conversationId,
        taskId: raw.taskId,
        tabId: raw.tabId,
        mode: value.mode,
        computerId,
        epoch: raw.epoch
      })
      await db.run(
        `INSERT INTO chat_threads(id,parent_tab_id,task_id,mode,parent_conversation_id,answer_id,source_message_id,source_uuid,title,created_at) VALUES(?,?,?,?,?,?,?,?,'Thread',?) ON CONFLICT(id) DO NOTHING`,
        [
          raw.tabId,
          value.parentTabId,
          raw.taskId,
          value.mode,
          value.parentConversationId ?? '',
          value.answerId ?? '',
          value.sourceMessageId ?? '',
          value.sourceUuid ?? '',
          value.createdAt ?? Date.now()
        ]
      )
    }
    if (
      !current ||
      current.computerId !== computerId ||
      current.epoch !== raw.epoch ||
      current.tabId !== raw.tabId ||
      current.taskId !== raw.taskId ||
      current.state !== 'active'
    )
      throw new Error('Chat metadata ownership mismatch')
    await opts.gate?.(computerId, current.taskId)
    const value = raw.value as Record<string, unknown>
    if (raw.kind === 'provider-config') {
      const allowed = new Set([
        'chatMode',
        'chatModel',
        'chatEffort',
        'chatCollaboration',
        'chatFastMode',
        'chatConversationId',
        'conversationId'
      ])
      const mode = String(value.mode),
        key = String(value.key)
      if (
        !allowed.has(key) ||
        !['claude-chat', 'claude-code', 'codex-chat', 'codex'].includes(mode)
      )
        throw new Error('Invalid provider metadata')
      const path = `$.${JSON.stringify(mode)}`
      await db.run(
        `UPDATE tasks SET provider_config=(SELECT json_set(json_set(cfg,?,CASE WHEN json_type(cfg,?)='object' THEN json(json_extract(cfg,?)) ELSE json('{}') END),?,json(?)) FROM (SELECT CASE WHEN json_valid(provider_config) THEN provider_config ELSE '{}' END cfg)) WHERE id=?`,
        [path, path, path, `${path}.${key}`, JSON.stringify(value.value), current.taskId]
      )
    } else if (raw.kind === 'conversation') {
      const input = value as unknown as {
        mode: string
        conversationId: string | null
        origin: string
        legacyJsonField?: string
      }
      if (input.conversationId)
        await ownership.bindProvider(current.id, input.conversationId, input.mode)
      await db.run(
        `INSERT INTO task_conversations(id,task_id,mode,conversation_id,origin,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        [
          raw.operationId,
          current.taskId,
          input.mode,
          input.conversationId,
          input.origin,
          Date.now()
        ]
      )
    } else if (raw.kind === 'activity') {
      const at = Number(value.at)
      if (!Number.isSafeInteger(at)) throw new Error('Invalid activity metadata')
      await db.run(
        'UPDATE tasks SET last_interaction_at=? WHERE id=? AND (last_interaction_at IS NULL OR last_interaction_at<?)',
        [at, current.taskId, at]
      )
    } else if (raw.kind === 'agent-state') {
      if (!['running', 'stopped', 'auto_stopped'].includes(String(value.state)))
        throw new Error('Invalid agent state metadata')
      await db.run('UPDATE terminal_tabs SET agent_state=? WHERE id=?', [
        value.state,
        current.tabId
      ])
    } else if (
      ['artifact-changed', 'artifact-deleted', 'folder-changed', 'folder-deleted'].includes(
        raw.kind
      )
    ) {
      const isFolder = raw.kind.startsWith('folder'),
        id = String(value.id),
        table = isFolder ? 'artifact_folders' : 'task_artifacts',
        locations = isFolder ? 'chat_folder_locations' : 'chat_artifact_locations',
        idColumn = isFolder ? 'folder_id' : 'artifact_id'
      if (!id || id.length > 200) throw new Error('Invalid artifact locator')
      const previous = await db.get<{ task_id: string; computer_id: string | null }>(
        `SELECT a.task_id,o.computer_id FROM ${table} a LEFT JOIN ${locations} l ON l.${idColumn}=a.id LEFT JOIN chat_ownership o ON o.id=l.conversation_id WHERE a.id=?`,
        [id]
      )
      if (previous && (previous.task_id !== current.taskId || previous.computer_id !== computerId))
        throw new Error('Artifact locator belongs to another owner')
      if (raw.kind.endsWith('deleted')) {
        await db.run(`DELETE FROM ${table} WHERE id=?`, [id])
      } else {
        const parent = String((isFolder ? value.parentId : value.folderId) ?? '') || null
        if (parent) {
          const folder = await db.get<{ task_id: string }>(
            'SELECT task_id FROM artifact_folders WHERE id=?',
            [parent]
          )
          if (folder && folder.task_id !== current.taskId)
            throw new Error('Folder locator task mismatch')
          if (!folder)
            await db.run("INSERT INTO artifact_folders(id,task_id,name) VALUES(?,?,'Chat files')", [
              parent,
              current.taskId
            ])
        }
        if (isFolder)
          await db.run(
            `INSERT INTO artifact_folders(id,task_id,name,parent_id,"order") VALUES(?,?,'Chat files',?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,"order"=excluded."order"`,
            [id, current.taskId, parent, Number.isSafeInteger(value.order) ? value.order : 0]
          )
        else
          await db.run(
            `INSERT INTO task_artifacts(id,task_id,title,folder_id,"order") VALUES(?,?,'Chat attachment',?,?) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,"order"=excluded."order"`,
            [id, current.taskId, parent, Number.isSafeInteger(value.order) ? value.order : 0]
          )
        await db.run(
          `INSERT INTO ${locations}(${idColumn},conversation_id) VALUES(?,?) ON CONFLICT(${idColumn}) DO NOTHING`,
          [id, current.id]
        )
      }
    } else if (raw.kind === 'queue-item') {
      await ownership.setQueueRoute(String(value.id), current.id, value.removed === true)
    } else if (raw.kind !== 'thread-created') throw new Error('Unknown chat metadata kind')
    opts.onTasksChanged?.(current.taskId)
    if (advance)
      await db.run(
        'INSERT INTO chat_metadata_progress(conversation_id,sequence) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET sequence=MAX(chat_metadata_progress.sequence,excluded.sequence)',
        [current.id, raw.sequence]
      )
  }
  const metadataChains = new Map<string, Promise<void>>()
  async function recoverMetadataNow(computerId: string, id: string) {
    const snapshot = (await opts.request(computerId, {
      kind: 'metadata.snapshot',
      id
    })) as ChatMetadataSnapshot
    const owner = await ownership.get(id)
    if (
      !owner ||
      owner.computerId !== computerId ||
      owner.state !== 'active' ||
      snapshot.identity.id !== id ||
      snapshot.identity.taskId !== owner.taskId ||
      snapshot.identity.tabId !== owner.tabId ||
      snapshot.identity.epoch !== owner.epoch ||
      !Number.isSafeInteger(snapshot.counter) ||
      snapshot.counter < 0
    )
      throw new Error('Invalid metadata snapshot ownership')
    await opts.gate?.(computerId, owner.taskId)
    const consumed =
      (
        await db.get<{ sequence: number }>(
          'SELECT sequence FROM chat_metadata_progress WHERE conversation_id=?',
          [id]
        )
      )?.sequence ?? 0
    if (snapshot.counter < consumed) throw new Error('Computer metadata is behind the hub')
    await db.run('DELETE FROM chat_queue_routes WHERE conversation_id=?', [id])
    // Idempotent metadata writes precede the high-water mark. A crash replays them.
    for (const update of snapshot.updates) {
      if (
        update.sequence !== snapshot.counter ||
        update.conversationId !== id ||
        update.taskId !== owner.taskId ||
        update.tabId !== owner.tabId ||
        update.epoch !== owner.epoch
      )
        throw new Error('Invalid metadata snapshot entry')
      await applyMetadata(computerId, update, false)
    }
    for (const [table, locations, column, kind] of [
      ['task_artifacts', 'chat_artifact_locations', 'artifact_id', 'artifact-changed'],
      ['artifact_folders', 'chat_folder_locations', 'folder_id', 'folder-changed']
    ]) {
      const ids = new Set(
        snapshot.updates
          .filter((u) => u.kind === kind)
          .map((u) => String((u.value as { id: string }).id))
      )
      const previous = await db.all<{ id: string }>(
        `SELECT ${column} AS id FROM ${locations} WHERE conversation_id=?`,
        [id]
      )
      for (const row of previous)
        if (!ids.has(row.id)) await db.run(`DELETE FROM ${table} WHERE id=?`, [row.id])
    }
    await db.run(
      'INSERT INTO chat_metadata_progress(conversation_id,sequence) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET sequence=MAX(chat_metadata_progress.sequence,excluded.sequence)',
      [id, snapshot.counter]
    )
  }
  function recoverMetadata(computerId: string, id: string) {
    const previous = metadataChains.get(id) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => recoverMetadataNow(computerId, id))
      .finally(() => {
        if (metadataChains.get(id) === next) metadataChains.delete(id)
      })
    metadataChains.set(id, next)
    return next
  }
  function reconcileMetadata(computerId: string, update: ChatMetadataUpdate) {
    const key = update.conversationId,
      previous = metadataChains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (!Number.isSafeInteger(update.sequence) || update.sequence < 1)
          throw new Error('Invalid chat metadata sequence')
        let consumed =
          (
            await db.get<{ sequence: number }>(
              'SELECT sequence FROM chat_metadata_progress WHERE conversation_id=?',
              [key]
            )
          )?.sequence ?? 0
        if (update.sequence > consumed + 1) {
          await recoverMetadataNow(computerId, key)
          consumed =
            (
              await db.get<{ sequence: number }>(
                'SELECT sequence FROM chat_metadata_progress WHERE conversation_id=?',
                [key]
              )
            )?.sequence ?? 0
        }
        if (update.sequence > consumed) await applyMetadata(computerId, update)
        else {
          const owner = await ownership.get(key)
          if (
            owner?.computerId !== computerId ||
            owner.epoch !== update.epoch ||
            owner.state !== 'active'
          )
            throw new Error('Stale metadata owner')
        }
        await opts.request(computerId, {
          kind: 'ackMetadata',
          id: key,
          operationId: update.operationId
        })
      })
      .finally(() => {
        if (metadataChains.get(key) === next) metadataChains.delete(key)
      })
    metadataChains.set(key, next)
    return next
  }
  async function drainMetadata(computerId: string, restore = false) {
    if (restore) {
      const owners = await db.all<{ id: string }>(
        "SELECT id FROM chat_ownership WHERE computer_id=? AND state='active' ORDER BY id",
        [computerId]
      )
      for (const owner of owners) await recoverMetadata(computerId, owner.id)
    }
    const updates = (await opts.request(computerId, {
      kind: 'pendingMetadata'
    })) as ChatMetadataUpdate[]
    updates.sort(
      (a, b) => a.conversationId.localeCompare(b.conversationId) || a.sequence - b.sequence
    )
    for (const update of updates) await reconcileMetadata(computerId, update)
  }
  async function invoke(
    target: 'ops' | 'queue',
    method: string,
    args: unknown[],
    operationId?: string
  ): Promise<unknown> {
    args = trimUnsetArgs(args)
    if (target === 'ops' && method === 'supports') return supportsChatMode(String(args[0]))
    if (target === 'ops' && catalogMethods.has(method))
      return catalogCall(method as ChatCatalogOperation, {}, args)
    const owner = await route(target, method, args)
    await sync(owner)
    await opts.beforeInvoke?.(owner, method, args)
    const read =
      target === 'queue' ? method === 'list' : CHAT_READ_OPERATIONS.has(method as ChatOperation)
    const result = await opts.request(owner.computerId!, {
      kind: 'invoke',
      value: {
        route: { id: owner.id, epoch: owner.epoch },
        target,
        method,
        args,
        ...(!read ? { operationId: operationId ?? randomUUID() } : {})
      }
    })
    if (!read) await drainMetadata(owner.computerId!)
    return result
  }
  async function catalogCall(
    method: ChatCatalogOperation,
    context: ChatCatalogContext,
    args: unknown[]
  ) {
    const owner = context.tabId
      ? await ensureTab(context.tabId)
      : context.taskId
        ? await ensureTask(context.taskId)
        : null
    const computerId = owner?.computerId ?? (await opts.defaultComputer())
    if (!computerId) throw new Error('Chat computer unavailable. Connect a computer.')
    if (owner) await sync(owner)
    return opts.request(computerId, {
      kind: 'catalog',
      method,
      args: trimUnsetArgs(args),
      operationId: randomUUID(),
      ...(owner ? { route: { id: owner.id, epoch: owner.epoch } } : {})
    })
  }
  async function refreshSessions(computerId: string) {
    const rows = (await opts.request(computerId, { kind: 'sessions' })) as Array<
      ChatSessionStateEntry & { providerSessionId?: string | null }
    >
    const accepted: Array<ChatSessionStateEntry & { providerSessionId?: string | null }> = []
    for (const row of rows) {
      const tabId = row.sessionId.slice(row.taskId.length + 1),
        owner = await ownership.forTab(tabId)
      if (
        owner?.computerId !== computerId ||
        owner.taskId !== row.taskId ||
        owner.state !== 'active'
      )
        continue
      accepted.push(row)
    }
    for (const [id, row] of sessionMirror)
      if (row.computerId === computerId) sessionMirror.delete(id)
    for (const row of accepted) sessionMirror.set(row.sessionId, { ...row, computerId })
  }
  const sessions = {
    list: () => [...sessionMirror.values()].map(({ computerId, providerSessionId, ...row }) => row),
    get: (id: string) => sessionMirror.get(id)?.state ?? null
  }
  const conversations = {
    isLive: (taskId: string, providerSessionId: string) =>
      [...sessionMirror.values()].some(
        (r) => r.taskId === taskId && r.providerSessionId === providerSessionId
      ),
    release: async (taskId: string, providerSessionId: string) => {
      for (const row of [...sessionMirror.values()])
        if (row.taskId === taskId && row.providerSessionId === providerSessionId)
          await invoke('ops', 'kill', [row.sessionId.slice(taskId.length + 1)])
    }
  }
  const ops = Object.fromEntries(
    Object.keys(chatOperationSchemas).map((method) => [
      method,
      (...args: unknown[]) =>
        method === 'send'
          ? invoke('ops', method, args.slice(0, 2), args[2] as string | undefined)
          : invoke('ops', method, args)
    ])
  ) as ChatDeps['ops']
  const queueOps = Object.fromEntries(
    Object.keys(chatQueueOperationSchemas).map((method) => [
      method,
      (...args: unknown[]) => invoke('queue', method, args)
    ])
  ) as ChatDeps['queueOps']
  const catalog = Object.fromEntries(
    [...catalogMethods].map((method) => [
      method,
      (context: ChatCatalogContext, ...args: unknown[]) =>
        catalogCall(method as ChatCatalogOperation, context, args)
    ])
  ) as ChatCatalog
  return {
    ops,
    queueOps,
    catalog,
    events,
    queueEvents,
    sessions,
    conversations,
    refreshSessions,
    async resetCaches() {
      await Promise.allSettled([...taskMigrations.values(), ...metadataChains.values()])
      sessionMirror.clear()
      taskMigrations.clear()
    },
    invoke,
    ensureTab,
    ensureTask,
    ensurePromptTask,
    drainMetadata,
    reconcileMetadata,
    recoverMetadata,
    async receive(computerId: string, payload: unknown) {
      const p = payload as Record<string, unknown>
      if (p.type === 'metadata')
        return reconcileMetadata(computerId, p.update as ChatMetadataUpdate)
      const owner = await ownership.get(String(p.conversationId))
      if (
        !owner ||
        owner.computerId !== computerId ||
        owner.epoch !== p.epoch ||
        owner.tabId !== p.tabId ||
        owner.state !== 'active'
      )
        throw new Error('Chat event ownership mismatch')
      await opts.gate?.(computerId, owner.taskId)
      switch (p.type) {
        case 'event':
          events.emit(
            'event',
            owner.tabId,
            p.event as AgentEvent,
            Number(p.seq),
            p.live as number | undefined,
            p.at as number | undefined
          )
          break
        case 'exit':
          sessionMirror.delete(String(p.sessionId))
          events.emit(
            'exit',
            owner.tabId,
            String(p.sessionId),
            p.code as number | null,
            p.signal as string | null
          )
          break
        case 'threads-changed':
          events.emit('threads-changed', owner.tabId)
          break
        case 'queue-changed':
          queueEvents.emit('queue-changed', owner.tabId)
          break
        case 'queue-drained':
          queueEvents.emit('queue-drained', owner.tabId, String(p.original))
          break
        case 'state':
          if (p.newState !== 'not-spawned' && p.newState !== 'dead')
            sessionMirror.set(String(p.sessionId), {
              sessionId: String(p.sessionId),
              taskId: owner.taskId,
              mode: owner.mode,
              state: p.newState as ChatSessionStateEntry['state'],
              lastOutputTime: Date.now(),
              computerId,
              providerSessionId: p.providerSessionId as string | null
            })
          else sessionMirror.delete(String(p.sessionId))
          opts.onState?.(
            String(p.sessionId),
            p.newState as ChatTerminalState,
            p.oldState as ChatTerminalState
          )
          break
      }
    }
  }
}
