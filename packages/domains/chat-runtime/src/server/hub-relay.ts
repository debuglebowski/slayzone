import { randomUUID, createHash } from 'node:crypto'
import { TypedEmitter } from '@slayzone/platform/events'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  assertChatTabStateScope,
  isChatSupported,
  type ChatTabStateScope,
  chatAgentIdForTerminal,
  type AgentEvent,
  type ChatSavedSummary,
  type ChatSessionStateEntry
} from '@slayzone/terminal-contracts'
import type {
  ChatTerminalState,
  ChatDeps,
  ChatEventMap,
  ChatQueueEventMap,
  ChatCatalog,
  ChatCatalogOperation,
  ChatCatalogContext,
  QueueAdmission,
  ChatQueuePushOptions
} from '@slayzone/terminal/runtime'
import {
  chatOperationSchemas,
  chatQueueOperationSchemas,
  parseChatInvocation,
  CHAT_READ_OPERATIONS,
  COMPUTER_OWNED_CHAT_KEYS,
  type ChatOperation,
  type ChatQueueOperation
} from '../shared'
import type { ChatBootstrap, ChatMetadataUpdate, ChatMetadataSnapshot } from './local-data'
import { retiredComputerSql, type ChatOwnershipStore, type HubChatOwnership } from './hub-ownership'
import { chatComputer, ChatUnavailableError } from './hub-chat-computer'
import type { ChatComputerRequest } from './migration'
import { createHistoryProgress } from './hub-history-progress'
import { createChatFolderDeletions } from './hub-folders'
import { chatStorageMode, isStorageOnlyChatOwner } from './storage-mode'
import { legacyChatTabContentSql, legacyChatTaskContentSql } from './legacy-census'
import { legacyChatTables } from '@slayzone/platform/legacy-chat-tables'
import { createHubProviderTransitions } from './hub-provider-transition'
import { isComputerUnreachable, isolateItem } from './hub-isolation'
import {
  createAsyncFaultLedger,
  forEachIsolated,
  StructuralFaultError
} from '@slayzone/platform/isolation'

const trimUnsetArgs = (args: unknown[]) => {
  let end = args.length
  while (end && args[end - 1] === undefined) end--
  return args.slice(0, end)
}

type TabRow = { id: string; task_id: string; mode: string }
// Storage migration must not depend on which native/chat handoffs the UI
// currently exposes. Dormant Codex chat exists even when handoff is disabled.
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
// These reads consume stored events/projections, not subprocess configuration.
// Routing still recovers ownership and applies lifecycle/deletion fences first.
const historyReadMethods = new Set([
  'getBufferSince',
  'getReplay',
  'openTimeline',
  'timelinePages',
  'searchTimeline'
])

/** Calls that open a tab's session on the computer: a send behind one waits for it. */
/** Queue operations on one queued message: `[itemId, …, tabId]`. */
const QUEUE_ITEM_METHODS = new Set(['update', 'move', 'hold', 'release', 'steer', 'remove'])
const SESSION_OPENING_OPS = new Set(['hydrate', 'start', 'reset', 'refuseStart'])

/** The tab a call names: its first argument, or that argument's `tabId`. */
function tabIdOf(first: unknown): string {
  return first && typeof first === 'object' && 'tabId' in first
    ? String(first.tabId)
    : String(first)
}

/** Metadata routing only. This facade never instantiates a chat process or content store. */
export function createHubChatRelay(opts: {
  db: SlayzoneDb
  ownership: ChatOwnershipStore
  request: ChatComputerRequest
  /** Pure stop controls skip lifecycle/recovery frames unsupported by an old host. */
  stopRequest?: ChatComputerRequest
  chatRuntimeReady?(computerId: string): boolean
  hasLegacyTaskContent?(taskId: string): Promise<boolean>
  resolveMigrationComputer?(owner: HubChatOwnership): Promise<string | null>
  resolveComputer(taskId: string): Promise<string | null>
  defaultComputer(): Promise<string | null>
  gate?(computerId: string, taskId: string): Promise<void>
  recoverComputer?(computerId: string, force?: boolean): Promise<void>
  /** A conversation's state could not be applied; the pass went on without it. */
  onConversationFailure?(computerId: string, conversationId: string, error: Error): void
  /**
   * Why this conversation is fenced (its last recovery or metadata pass failed),
   * if it is. Its chat refuses with this error; opening it again retries recovery.
   */
  conversationFence?(conversationId: string): Error | undefined
  bootstrap(owner: HubChatOwnership): Promise<ChatBootstrap>
  migrate(id: string, computerId: string): Promise<HubChatOwnership>
  beforeInvoke?(owner: HubChatOwnership, method: string, args: unknown[]): Promise<void>
  quiesceProvider?(owner: HubChatOwnership): Promise<void>
  /** A reserved provider switch was superseded (logged; never shown to the user). */
  onProviderTransitionSuperseded?(info: {
    id: string
    conversationId: string
    taskId: string
    reason: string
  }): void
  onTasksChanged?(taskId: string): void
  /**
   * A task's sessions changed on its computer (a chat recorded a conversation in
   * its ledger): the sessions list refreshes. The hub keeps no copy (§9).
   */
  onSessionsChanged?(taskId: string): void
  onState?(
    sessionId: string,
    state: ChatTerminalState,
    previous: ChatTerminalState,
    hasUserInput: boolean
  ): void | Promise<void>
  /** A session's count of background commands still running changed. */
  onBackgroundJobs?(sessionId: string, count: number): void | Promise<void>
}) {
  const { db, ownership } = opts
  const providerTransitions = createHubProviderTransitions({
    ...opts,
    quiesce: opts.quiesceProvider,
    onSuperseded: opts.onProviderTransitionSuperseded
  })
  const folderDeletions = createChatFolderDeletions(db)
  const events = new TypedEmitter<ChatEventMap>(),
    queueEvents = new TypedEmitter<ChatQueueEventMap>()
  const sessionMirror = new Map<
    string,
    ChatSessionStateEntry & { computerId: string; providerSessionId?: string | null }
  >()
  const taskMigrations = new Map<string, Promise<Map<string, Error>>>()
  const registrations = new Map<string, Promise<HubChatOwnership>>()
  const queueIngress = new Map<string, Promise<void>>()
  /**
   * Per tab: the call opening its session on the computer (hydrate, start, reset,
   * refuseStart), from the moment it entered the hub until the computer answered.
   * Calls take different ways through the hub (ownership, bootstrap, config reads),
   * so a send right behind its tab's hydrate could reach the computer first; it
   * waits here instead. A failed opening holds nothing back.
   */
  const opening = new Map<string, Promise<void>>()
  function openSession<T>(tabId: string, work: () => Promise<T>): Promise<T> {
    const run = work()
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined
    )
    opening.set(tabId, settled)
    void settled.then(() => {
      if (opening.get(tabId) === settled) opening.delete(tabId)
    })
    return run
  }
  /** Until every opening of the tab settled, one started meanwhile included. */
  async function afterOpening(tabId: string): Promise<void> {
    for (let pending = opening.get(tabId); pending; pending = opening.get(tabId)) {
      await pending
      if (opening.get(tabId) === pending) return
    }
  }
  function enterQueue(tabId: string) {
    const ready = queueIngress.get(tabId) ?? Promise.resolve()
    let release!: () => void
    let released = false
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = ready.then(() => current)
    queueIngress.set(tabId, tail)
    return {
      ready,
      release: () => {
        if (released) return
        released = true
        release()
        void tail.then(() => {
          if (queueIngress.get(tabId) === tail) queueIngress.delete(tabId)
        })
      }
    }
  }
  async function initialize(owner: HubChatOwnership) {
    const reservation = await ownership.bootstrapReservation(owner.id)
    if (!reservation) {
      const current = await ownership.get(owner.id)
      if (!current || current.state !== 'active')
        throw new Error('Chat initialization is no longer available')
      return current
    }
    await opts.gate?.(reservation.computerId, owner.taskId)
    const value = await opts.bootstrap({
      ...owner,
      computerId: reservation.computerId,
      state: 'active'
    })
    const reply = (await opts.request(reservation.computerId, { kind: 'bootstrap', value })) as {
      ok: boolean
      identity?: ChatBootstrap['identity']
    }
    if (
      !reply?.ok ||
      !reply.identity ||
      ['id', 'taskId', 'tabId', 'mode', 'epoch'].some(
        (key) =>
          reply.identity![key as keyof ChatBootstrap['identity']] !==
          value.identity[key as keyof ChatBootstrap['identity']]
      )
    )
      throw new Error('Invalid chat initialization acknowledgement')
    const active = await ownership.activateBootstrap(
      owner.id,
      reservation.computerId,
      reservation.epoch
    )
    await releaseStartingValues(active, value)
    return active
  }
  /**
   * The computer acknowledged a bootstrap: it holds its own chat settings for the
   * owner's (task, mode) now, seeded from the hub's starting values if it had none.
   * The hub's copy goes (decision 2: no copy, nothing to drift) — each key only if
   * it still holds the value that bootstrap carried: a starting value written since
   * (a template applied meanwhile) stays for the next bootstrap. A storage-only
   * owner never seeds settings, so it keeps them for the chat that will.
   */
  async function releaseStartingValues(owner: HubChatOwnership, sent: ChatBootstrap) {
    if (owner.state !== 'active' || isStorageOnlyChatOwner(owner)) return
    const seeded = sent.providerConfig as Record<string, unknown>
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await db.get<{ provider_config: string | null }>(
        'SELECT provider_config FROM tasks WHERE id=?',
        [owner.taskId]
      )
      if (!row?.provider_config) return
      let config: Record<string, Record<string, unknown>>
      try {
        config = JSON.parse(row.provider_config)
      } catch {
        return
      }
      const entry = config?.[owner.mode]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
      const keys = COMPUTER_OWNED_CHAT_KEYS.filter(
        (key) =>
          Object.hasOwn(entry, key) && JSON.stringify(entry[key]) === JSON.stringify(seeded[key])
      )
      if (!keys.length) return
      const next = { ...entry }
      for (const key of keys) delete next[key]
      const result = await db.run(
        'UPDATE tasks SET provider_config=? WHERE id=? AND provider_config=?',
        [JSON.stringify({ ...config, [owner.mode]: next }), owner.taskId, row.provider_config]
      )
      if (result.changes) return
    }
  }
  async function createTab(tab: TabRow) {
    const existing = await ownership.forTab(tab.id)
    if (existing)
      return (await ownership.bootstrapReservation(existing.id)) ? initialize(existing) : existing
    const tables = await legacyChatTables(db)
    const legacy =
      (await db.get(
        `SELECT 1 FROM terminal_tabs t JOIN tasks task ON task.id=t.task_id WHERE t.id=? AND
          (${legacyChatTabContentSql(tables)} OR ${legacyChatTaskContentSql(tables)} OR EXISTS(
            SELECT 1 FROM chat_cli_snapshots WHERE project_id=task.project_id AND mode=?))`,
        [tab.id, chatStorageMode(tab.mode)]
      )) || (await opts.hasLegacyTaskContent?.(tab.task_id))
    const pc = legacy ? null : await opts.resolveComputer(tab.task_id)
    if (!legacy && !pc) throw new Error('Chat computer unavailable. Connect its computer.')
    const value = {
      id: randomUUID(),
      taskId: tab.task_id,
      tabId: tab.id,
      mode: chatStorageMode(tab.mode),
      computerId: pc,
      epoch: 1
    }
    if (pc) {
      await opts.gate?.(pc, tab.task_id)
      // The durable reservation/binding exists before the first RPC. Tab deletion
      // can therefore fence both an absent store and a delayed successful reply.
      return initialize(await ownership.reserveBootstrap({ ...value, computerId: pc }))
    }
    return ownership.register(value, !tab.id.startsWith('prompt-history:'))
  }
  function registerTab(tab: TabRow) {
    const running = registrations.get(tab.id)
    if (running) return running
    const work = createTab(tab).finally(() => registrations.delete(tab.id))
    registrations.set(tab.id, work)
    return work
  }
  /**
   * Migrates every chat of a task that still needs it, each on its own: one
   * stuck chat (or the task-wide authority) fails alone and never stops the
   * others. Resolves with the failures by conversation id (`tab:<id>` for a tab
   * whose chat could not even be registered); never rejects, except when the
   * computer is unreachable (then no item can succeed).
   */
  function migrateTask(taskId: string): Promise<Map<string, Error>> {
    const existing = taskMigrations.get(taskId)
    if (existing) return existing
    const work = (async () => {
      const failures = new Map<string, Error>()
      const tables = await legacyChatTables(db)
      const tabs = await db.all<TabRow>(
        `SELECT t.id,t.task_id,t.mode FROM terminal_tabs t WHERE t.task_id=? AND (
          t.mode IN ('claude-chat','codex-chat') OR ${legacyChatTabContentSql(tables)})
          ORDER BY CASE WHEN EXISTS(SELECT 1 FROM chat_threads WHERE id=t.id) THEN 1 ELSE 0 END,t.created_at,t.id`,
        [taskId]
      )
      for (const tab of tabs)
        await isolateItem(
          `registration of chat tab ${tab.id}`,
          () => registerTab(tab),
          (error) => failures.set(`tab:${tab.id}`, error)
        )
      // Task-wide prompts/diagnostics outlive every closable terminal tab. Give
      // them their own durable authority before freezing any new tab snapshot.
      if (
        (await db.get(
          `SELECT 1 FROM tasks task WHERE task.id=? AND ${legacyChatTaskContentSql(tables)}`,
          [taskId]
        )) ||
        (await opts.hasLegacyTaskContent?.(taskId))
      ) {
        const tabId = `task-content:${taskId}`
        const owner =
          (await ownership.forTab(tabId)) ??
          (await ownership.register({
            id: randomUUID(),
            taskId,
            tabId,
            mode: 'claude-chat',
            computerId: null,
            epoch: 1
          }))
        await db.run(
          'INSERT INTO chat_legacy_task_authority VALUES(?,?) ON CONFLICT(task_id) DO NOTHING',
          [taskId, owner.id]
        )
      }
      for (const owner of await ownership.forTask(taskId)) {
        if (owner.state === 'deleted') continue
        await isolateItem(
          `migration of conversation ${owner.id}`,
          async () => {
            if (await ownership.bootstrapReservation(owner.id)) {
              await initialize(owner)
              return
            }
            if (owner.state === 'active' && !owner.cleanupPending) return
            const pc =
              owner.destinationComputerId ??
              (await (opts.resolveMigrationComputer
                ? opts.resolveMigrationComputer(owner)
                : opts.resolveComputer(taskId)))
            if (!pc)
              throw new Error('Chat computer unavailable. Connect its computer to migrate history.')
            await opts.gate?.(pc, taskId)
            await opts.migrate(owner.id, pc)
          },
          (error) => failures.set(owner.id, error)
        )
      }
      return failures
    })().finally(() => {
      taskMigrations.delete(taskId)
    })
    taskMigrations.set(taskId, work)
    return work
  }
  /** Every chat of the task migrated (prompt history spans all of them). */
  async function migrateWholeTask(taskId: string) {
    const [first] = (await migrateTask(taskId)).values()
    if (first) throw first
  }
  const tabEnsures = new Map<string, Promise<HubChatOwnership>>()
  function ensureTab(tabId: string) {
    const existing = tabEnsures.get(tabId)
    if (existing) return existing
    const work = ensureTabNow(tabId).finally(() => tabEnsures.delete(tabId))
    tabEnsures.set(tabId, work)
    return work
  }
  async function ensureTabNow(tabId: string) {
    await providerTransitions.settle(tabId)
    let owner = await ownership.forTab(tabId)
    if (opts.recoverComputer) {
      const taskId =
        owner?.taskId ??
        (await db.get<{ task_id: string }>('SELECT task_id FROM terminal_tabs WHERE id=?', [tabId]))
          ?.task_id
      // The chat's computer as the hub answers it everywhere (`chatComputer`). Also a
      // removed one: recovery applies its retirement first (repointing or retiring the
      // work that names it) and never asks it. Its chats are refused below with the
      // removal reason.
      const pc =
        (owner ? (await chatComputer(db, owner))?.id : null) ??
        (taskId ? await opts.resolveComputer(taskId) : null)
      if (pc)
        await opts.recoverComputer(
          pc,
          !!(
            owner &&
            ((await ownership.unavailable(owner.id)) || opts.conversationFence?.(owner.id))
          )
        )
      owner = await ownership.forTab(tabId)
    }
    if (!owner) {
      const tab = await db.get<TabRow>('SELECT id,task_id,mode FROM terminal_tabs WHERE id=?', [
        tabId
      ])
      if (
        !tab ||
        (!isChatSupported(chatStorageMode(tab.mode)) &&
          !(await db.get(
            `SELECT 1 FROM terminal_tabs t WHERE t.id=? AND ${legacyChatTabContentSql(await legacyChatTables(db))}`,
            [tab.id]
          )))
      )
        throw new Error('Unknown chat tab')
      owner = await registerTab(tab)
    }
    if (owner.state === 'deleted') throw new Error('Chat conversation deleted')
    const unavailable = await ownership.unavailable(owner.id)
    if (unavailable) throw new ChatUnavailableError(unavailable.reason)
    // Removed, its work not yet retired (applyComputerRetirements runs on recovery).
    if ((await chatComputer(db, owner))?.kind === 'removed')
      throw new ChatUnavailableError('computer-removed')
    const fence = opts.conversationFence?.(owner.id)
    if (fence) throw fence
    if (owner.state !== 'active' || owner.cleanupPending) {
      const failure = (await migrateTask(owner.taskId)).get(owner.id)
      if (failure) throw failure
      owner = (await ownership.get(owner.id))!
    } else if (
      // The task-wide authority still migrating (a deleted one only delivers
      // its removal: not migration work). A clean chat never waits on it: the
      // migration runs on, and a failure shows on the authority's own reads.
      await db.get(
        `SELECT 1 FROM chat_legacy_task_authority a JOIN chat_ownership o ON o.id=a.conversation_id WHERE a.task_id=?
        AND (o.state IN ('legacy','copying','verified') OR (o.state='active' AND o.cleanup_pending=1))`,
        [owner.taskId]
      )
    )
      void migrateTask(owner.taskId).catch(() => {
        /* Unreachable computer: the next open or recovery retries. */
      })
    if (!owner.computerId || owner.state !== 'active')
      throw new Error('Chat history migration is incomplete')
    for (;;) {
      const tab = await db.get<TabRow>('SELECT id,task_id,mode FROM terminal_tabs WHERE id=?', [
        tabId
      ])
      const mode = tab && chatStorageMode(tab.mode)
      if (!mode || !isChatSupported(mode) || mode === owner.mode) break
      await providerTransitions.ensure(owner, mode)
      owner = (await ownership.forTab(tabId))!
      if (!owner || owner.state === 'deleted')
        throw new Error('Chat tab was deleted during provider change')
      if (await ownership.bootstrapReservation(owner.id)) owner = await initialize(owner)
    }
    if (!owner.computerId || owner.state !== 'active')
      throw new Error('Chat provider initialization is incomplete')
    await opts.gate?.(owner.computerId, owner.taskId)
    return owner
  }
  async function ensureTask(taskId: string, mode?: string) {
    const tabs = await db.all<TabRow>(
      'SELECT id,task_id,mode FROM terminal_tabs WHERE task_id=? ORDER BY position,created_at,id',
      [taskId]
    )
    const tab =
      tabs.find((t) => isChatSupported(t.mode) && (!mode || t.mode === mode)) ??
      tabs.find((t) => (chatAgentIdForTerminal(t.mode) ?? t.mode) === mode)
    if (!tab) throw new Error('Task has no chat tab for this provider')
    return ensureTab(tab.id)
  }
  async function ensurePromptTask(taskId: string) {
    const pc = await opts.resolveComputer(taskId)
    const known = await ownership.forTask(taskId)
    const missing = new Set<string>()
    for (const owner of known)
      if (owner.computerId && (await ownership.unavailable(owner.id))) missing.add(owner.computerId)
    for (const computer of new Set([
      ...(pc ? [pc] : []),
      ...known.flatMap((owner) =>
        owner.state === 'active' && owner.computerId ? [owner.computerId] : []
      )
    ]))
      await opts.recoverComputer?.(computer, missing.has(computer))
    const owners = (await ownership.forTask(taskId)).filter((o) => o.state !== 'deleted')
    for (const owner of owners) {
      const unavailable = await ownership.unavailable(owner.id)
      if (unavailable) throw new ChatUnavailableError(unavailable.reason)
    }
    const tables = await legacyChatTables(db)
    if (owners.length) {
      if (
        (await db.get(
          `SELECT 1 FROM tasks task WHERE task.id=? AND ${legacyChatTaskContentSql(tables)}`,
          [taskId]
        )) ||
        (await opts.hasLegacyTaskContent?.(taskId))
      )
        await migrateWholeTask(taskId)
      for (const owner of owners)
        if (owner.state !== 'active' || owner.cleanupPending) {
          await migrateWholeTask(taskId)
          break
        }
      return (await ownership.forTask(taskId)).filter((o) => o.state === 'active')
    }
    const computerId = await opts.resolveComputer(taskId)
    if (!computerId) throw new Error('Prompt history computer unavailable')
    await opts.gate?.(computerId, taskId)
    const legacy =
      (await db.get(
        `SELECT 1 FROM tasks task WHERE task.id=? AND ${legacyChatTaskContentSql(tables)}`,
        [taskId]
      )) || (await opts.hasLegacyTaskContent?.(taskId))
    const owner = legacy
      ? await ownership.register({
          id: randomUUID(),
          taskId,
          tabId: `task-content:${taskId}`,
          mode: 'claude-chat',
          computerId: null,
          epoch: 1
        })
      : await registerTab({ id: `prompt-history:${taskId}`, task_id: taskId, mode: 'claude-chat' })
    if (legacy) {
      await migrateWholeTask(taskId)
      return (await ownership.forTask(taskId)).filter((o) => o.state === 'active')
    }
    await sync(owner)
    return [owner]
  }
  async function sync(owner: HubChatOwnership) {
    if (!owner.computerId) throw new Error('Chat computer unavailable')
    const value = await opts.bootstrap(owner)
    await opts.request(owner.computerId, { kind: 'bootstrap', value })
    await releaseStartingValues(owner, value)
  }
  async function route(target: 'ops' | 'queue', method: string, args: unknown[]) {
    const first = args[0]
    // A queued message is reached through its tab (its last argument): the hub keeps
    // no per-message routes (robustness plan §9, v208); the computer refuses an item
    // the named tab does not hold.
    if (target === 'queue' && QUEUE_ITEM_METHODS.has(method))
      return ensureTab(String(args[args.length - 1]))
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
      // Publish UI row, ownership and binding together. A close immediately
      // after the row becomes visible must already have a durable delete target.
      await db.batchTxn([
        {
          type: 'run',
          sql: `INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state)
          SELECT ?,?,?,?,?,?,'active' FROM chat_ownership p WHERE p.id=? AND p.task_id=? AND p.computer_id=? AND p.epoch=? AND p.state='active'
          AND NOT EXISTS(SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted')
          AND NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id<>?)
          AND NOT EXISTS(SELECT 1 FROM terminal_tabs WHERE id=? AND task_id<>?) ON CONFLICT(id) DO NOTHING`,
          params: [
            raw.conversationId,
            raw.taskId,
            raw.tabId,
            value.mode,
            computerId,
            raw.epoch,
            parent.id,
            raw.taskId,
            computerId,
            parent.epoch,
            raw.taskId,
            raw.tabId,
            raw.conversationId,
            raw.tabId,
            raw.taskId
          ]
        },
        {
          type: 'run',
          sql: `INSERT INTO terminal_tabs(id,task_id,label,mode,position,group_id)
          SELECT tab_id,task_id,'Thread',mode,-1,tab_id FROM chat_ownership WHERE id=? AND task_id=? AND tab_id=? AND mode=? AND computer_id=? AND epoch=? AND state='active'
          ON CONFLICT(id) DO NOTHING`,
          params: [raw.conversationId, raw.taskId, raw.tabId, value.mode, computerId, raw.epoch]
        },
        {
          type: 'run',
          sql: `INSERT INTO chat_tab_bindings(tab_id,conversation_id)
          SELECT o.tab_id,o.id FROM chat_ownership o JOIN terminal_tabs t ON t.id=o.tab_id AND t.task_id=o.task_id
          WHERE o.id=? AND o.task_id=? AND o.tab_id=? AND o.mode=? AND o.computer_id=? AND o.epoch=? AND o.state='active'
          ON CONFLICT(tab_id) DO NOTHING`,
          params: [raw.conversationId, raw.taskId, raw.tabId, value.mode, computerId, raw.epoch]
        },
        {
          type: 'run',
          sql: `INSERT INTO chat_threads(id,parent_tab_id,task_id,mode,parent_conversation_id,answer_id,source_message_id,source_uuid,title,created_at)
          SELECT ?,?,?,?,?,?,?,?,'Thread',? WHERE EXISTS(SELECT 1 FROM chat_tab_bindings b JOIN chat_ownership o ON o.id=b.conversation_id
            WHERE b.tab_id=? AND o.id=? AND o.state='active') ON CONFLICT(id) DO NOTHING`,
          params: [
            raw.tabId,
            value.parentTabId,
            raw.taskId,
            value.mode,
            value.parentConversationId ?? '',
            value.answerId ?? '',
            value.sourceMessageId ?? '',
            value.sourceUuid ?? '',
            value.createdAt ?? Date.now(),
            raw.tabId,
            raw.conversationId
          ]
        }
      ])
      current = await ownership.get(raw.conversationId)
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
    // Chat settings, session ids and queued messages are the computer's alone
    // (robustness plan §9, v208): only what feeds hub-owned state is reported.
    if (raw.kind === 'activity') {
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
      await reconcileFileLocation(current, computerId, raw.kind, value)
    } else if (raw.kind !== 'thread-created') throw new Error('Unknown chat metadata kind')
    opts.onTasksChanged?.(current.taskId)
    // The position and its receipt commit together: until the computer confirms
    // the ack, a redelivery of this very update is recognized as applied.
    if (advance)
      await db.batchTxn([
        {
          type: 'run',
          sql: `INSERT INTO chat_metadata_progress(conversation_id,sequence,store_id) VALUES(?,?,?)
            ON CONFLICT(conversation_id) DO UPDATE SET sequence=MAX(chat_metadata_progress.sequence,excluded.sequence),
            store_id=COALESCE(chat_metadata_progress.store_id,excluded.store_id)`,
          params: [current.id, raw.sequence, raw.storeId ?? null]
        },
        {
          type: 'run',
          sql: 'INSERT INTO chat_metadata_receipts(conversation_id,operation_id,sequence) VALUES(?,?,?) ON CONFLICT DO NOTHING',
          params: [current.id, raw.operationId, raw.sequence]
        }
      ])
  }
  async function reconcileFileLocation(
    current: HubChatOwnership,
    computerId: string,
    kind: string,
    value: Record<string, unknown>
  ) {
    const isFolder = kind.startsWith('folder'),
      id = value.id
    if (typeof id !== 'string' || !id || id.length > 200)
      throw new Error('Invalid artifact locator')
    if (isFolder && (await folderDeletions.deleted(current.taskId, id))) return
    const table = isFolder ? 'artifact_folders' : 'task_artifacts',
      locations = isFolder ? 'chat_folder_locations' : 'chat_artifact_locations',
      idColumn = isFolder ? 'folder_id' : 'artifact_id'
    const previous = await db.get<{ task_id: string; computer_id: string | null }>(
      `SELECT a.task_id,o.computer_id FROM ${table} a LEFT JOIN ${locations} l ON l.${idColumn}=a.id LEFT JOIN chat_ownership o ON o.id=l.conversation_id WHERE a.id=?`,
      [id]
    )
    const provisional =
      isFolder &&
      previous?.computer_id === null &&
      (await db.get('SELECT 1 FROM chat_folder_placeholders WHERE folder_id=? AND task_id=?', [
        id,
        current.taskId
      ]))
    // The computer holding an entry is its authority: it may report the entry
    // under another of its tasks (a move). No other computer may claim it.
    const moved = !!previous && previous.task_id !== current.taskId
    if (
      previous &&
      ((moved && previous.computer_id !== computerId) ||
        (previous.computer_id !== computerId && !provisional))
    )
      throw new Error('Artifact locator belongs to another owner')
    if (moved && !kind.endsWith('deleted')) {
      await db.batchTxn([
        {
          type: 'run',
          sql: `UPDATE ${table} SET task_id=? WHERE id=?`,
          params: [current.taskId, id]
        },
        ...(isFolder
          ? []
          : [
              {
                type: 'run' as const,
                sql: 'UPDATE tasks SET active_artifact_id=NULL WHERE id=? AND active_artifact_id=?',
                params: [previous.task_id, id]
              }
            ])
      ])
    }
    if (kind.endsWith('deleted')) {
      if (isFolder) await folderDeletions.record(current.taskId, [id])
      else await db.run('DELETE FROM task_artifacts WHERE id=?', [id])
      return
    }
    let parent = (isFolder ? value.parentId : value.folderId) ?? null
    if (parent !== null && (typeof parent !== 'string' || !parent || parent.length > 200))
      throw new Error('Invalid parent folder locator')
    if (parent && (await folderDeletions.deleted(current.taskId, String(parent)))) {
      if (isFolder) {
        await folderDeletions.record(current.taskId, [id])
        return
      }
      parent = null
    }
    if (parent) {
      const folder = await db.get<{ task_id: string }>(
        'SELECT task_id FROM artifact_folders WHERE id=?',
        [parent]
      )
      if (folder && folder.task_id !== current.taskId)
        throw new Error('Folder locator task mismatch')
      if (!folder)
        await db.batchTxn([
          {
            type: 'run',
            sql: "INSERT INTO artifact_folders(id,task_id,name) SELECT ?,?,'Chat files' WHERE NOT EXISTS(SELECT 1 FROM chat_folder_deletions WHERE folder_id=?) ON CONFLICT(id) DO NOTHING",
            params: [parent, current.taskId, parent]
          },
          {
            type: 'run',
            sql: 'INSERT INTO chat_folder_placeholders(folder_id,task_id) SELECT ?,? WHERE changes()=1 ON CONFLICT(folder_id) DO NOTHING',
            params: [parent, current.taskId]
          },
          {
            type: 'run',
            sql: `INSERT INTO chat_folder_placeholder_waits(folder_id,conversation_id) SELECT ?,?
              WHERE EXISTS(SELECT 1 FROM chat_folder_placeholders WHERE folder_id=?) ON CONFLICT DO NOTHING`,
            params: [parent, current.id, parent]
          }
        ])
    }
    const order = Number.isSafeInteger(value.order) ? value.order : 0
    if (isFolder)
      await db.run(
        `INSERT INTO artifact_folders(id,task_id,name,parent_id,"order")
        SELECT ?,?,'Chat files',?,? WHERE NOT EXISTS(SELECT 1 FROM chat_folder_deletions WHERE folder_id IN (?,?))
        ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,"order"=excluded."order" WHERE task_id=excluded.task_id`,
        [id, current.taskId, parent, order, id, parent]
      )
    else
      await db.run(
        `INSERT INTO task_artifacts(id,task_id,title,folder_id,"order")
        VALUES(?,?,'Chat attachment',CASE WHEN EXISTS(SELECT 1 FROM chat_folder_deletions WHERE folder_id=?) THEN NULL ELSE ? END,?)
        ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,"order"=excluded."order" WHERE task_id=excluded.task_id`,
        [id, current.taskId, parent, parent, order]
      )
    await db.run(
      // Reported by its computer: no longer "unavailable on computer".
      `INSERT INTO ${locations}(${idColumn},conversation_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM ${table} WHERE id=? AND task_id=?)
        ON CONFLICT(${idColumn}) DO UPDATE SET conversation_id=excluded.conversation_id,unavailable_reason=NULL,unavailable_since=NULL`,
      [id, current.id, id, current.taskId]
    )
    if (isFolder)
      await db.batchTxn([
        {
          type: 'run',
          sql: 'DELETE FROM chat_folder_placeholders WHERE folder_id=?',
          params: [id]
        },
        {
          type: 'run',
          sql: 'DELETE FROM chat_folder_placeholder_waits WHERE folder_id=?',
          params: [id]
        }
      ])
    // This conversation holds an entry inside a placeholder: the placeholder
    // waits on it until it is re-read without the folder's own record.
    if (parent)
      await db.run(
        `INSERT INTO chat_folder_placeholder_waits(folder_id,conversation_id) SELECT ?,?
        WHERE EXISTS(SELECT 1 FROM chat_folder_placeholders WHERE folder_id=?) ON CONFLICT DO NOTHING`,
        [parent, current.id, parent]
      )
  }
  /**
   * Placeholders no live conversation can still supply resolve to normal
   * folders: every holder was re-read without the folder's own record, or is
   * deleted or on a computer removed for good. Otherwise they would stay
   * "awaiting computer" forever.
   */
  async function resolvePlaceholders(taskId: string) {
    await db.run(
      `DELETE FROM chat_folder_placeholders WHERE task_id=? AND NOT EXISTS(
        SELECT 1 FROM chat_folder_placeholder_waits w JOIN chat_ownership o ON o.id=w.conversation_id
        WHERE w.folder_id=chat_folder_placeholders.folder_id AND o.state<>'deleted'
          AND NOT (o.computer_id IS NOT NULL AND ${retiredComputerSql('o.computer_id')}))`,
      [taskId]
    )
  }
  const metadataChains = new Map<string, Promise<void>>()
  /** Per conversation: saved events relayed to clients without a gap. */
  const history = createHistoryProgress()
  /**
   * Per conversation: the task state version of the last metadata snapshot this
   * hub applied (in memory: a hub restart re-reads every conversation once). Live
   * updates never set it: one cannot vouch for writes that sent no update.
   */
  const appliedStateVersions = new Map<string, number>()
  /** Confirmed receipts kept per conversation to recognize late duplicates. */
  const ACKED_RECEIPTS_KEPT = 256
  const metadataProgress = (id: string) =>
    db.get<{ sequence: number; store_id: string | null }>(
      'SELECT sequence,store_id FROM chat_metadata_progress WHERE conversation_id=?',
      [id]
    )
  const hasReceipt = async (id: string, operationId: string) =>
    !!(await db.get(
      'SELECT 1 FROM chat_metadata_receipts WHERE conversation_id=? AND operation_id=?',
      [id, operationId]
    ))
  /**
   * Re-read one conversation's metadata in full: the computer is its authority.
   * `rollback`: the computer's counter went back (restored from a backup) or
   * it counts in another database. The cursor then moves to the computer's
   * counter even when that is behind the hub's, and files the hub knows but the
   * computer no longer lists are kept, marked "unavailable on computer"
   * (decision 4: they may still be wanted; the hub cannot tell).
   */
  async function recoverMetadataNow(computerId: string, id: string, rollback = false) {
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
      snapshot.counter < 0 ||
      typeof snapshot.storeId !== 'string' ||
      !snapshot.storeId ||
      !Array.isArray(snapshot.pending) ||
      snapshot.pending.some((op) => typeof op !== 'string' || !op)
    )
      throw new Error('Invalid metadata snapshot ownership')
    await opts.gate?.(computerId, owner.taskId)
    const progress = await metadataProgress(id)
    const consumed = progress?.sequence ?? 0
    // Behind the hub, or counted in another database: never proof of anything
    // the hub applied. The computer's state wins.
    rollback ||=
      snapshot.counter < consumed ||
      (!!progress?.store_id && progress.store_id !== snapshot.storeId)
    // Placeholders this conversation was holding before this full re-read.
    const waited = await db.all<{ folder_id: string }>(
      'SELECT folder_id FROM chat_folder_placeholder_waits WHERE conversation_id=?',
      [id]
    )
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
      const previous = await db.all<{ id: string; unavailable_reason: string | null }>(
        `SELECT ${column} AS id,unavailable_reason FROM ${locations} WHERE conversation_id=?`,
        [id]
      )
      for (const row of previous) {
        if (ids.has(row.id)) continue
        // An entry already known missing stays marked: a later normal re-read
        // does not turn "unavailable" into a silent delete.
        if (rollback || row.unavailable_reason !== null)
          await db.run(
            `UPDATE ${locations} SET unavailable_reason=COALESCE(unavailable_reason,'missing-on-computer'),
              unavailable_since=COALESCE(unavailable_since,?) WHERE ${column}=?`,
            [Date.now(), row.id]
          )
        else await db.run(`DELETE FROM ${table} WHERE id=?`, [row.id])
      }
    }
    // Cursor, store and receipts together. The snapshot already holds the effect
    // of every update still pending on the computer: those are receipts now (a
    // delivery acks them, never applies them again). Receipts it does not list
    // were acknowledged already.
    await db.batchTxn([
      {
        type: 'run',
        sql: `INSERT INTO chat_metadata_progress(conversation_id,sequence,store_id) VALUES(?,?,?)
          ON CONFLICT(conversation_id) DO UPDATE SET store_id=excluded.store_id,sequence=${
            rollback
              ? 'excluded.sequence'
              : 'MAX(chat_metadata_progress.sequence,excluded.sequence)'
          }`,
        params: [id, snapshot.counter, snapshot.storeId]
      },
      // Unconfirmed receipts are exactly the snapshot's pending updates now.
      // Confirmed ones stay (late duplicates); a rollback's new operations
      // have new ids, so they never match.
      {
        type: 'run',
        sql: 'DELETE FROM chat_metadata_receipts WHERE conversation_id=? AND acked=0',
        params: [id]
      },
      ...snapshot.pending.map((operationId) => ({
        type: 'run' as const,
        sql: 'INSERT INTO chat_metadata_receipts(conversation_id,operation_id,sequence) VALUES(?,?,?) ON CONFLICT DO UPDATE SET acked=0',
        params: [id, operationId, snapshot.counter]
      }))
    ])
    // Re-read in full without those folders' own records: it cannot supply them.
    // (A placeholder this very read created keeps waiting until the next one.)
    for (const { folder_id } of waited)
      await db.run(
        'DELETE FROM chat_folder_placeholder_waits WHERE folder_id=? AND conversation_id=?',
        [folder_id, id]
      )
    await resolvePlaceholders(owner.taskId)
    if (Number.isSafeInteger(snapshot.stateVersion))
      appliedStateVersions.set(
        id,
        rollback
          ? (snapshot.stateVersion as number)
          : Math.max(appliedStateVersions.get(id) ?? 0, snapshot.stateVersion as number)
      )
  }
  function recoverMetadata(computerId: string, id: string) {
    const previous = metadataChains.get(id) ?? Promise.resolve()
    const next = previous
      .catch(() => {
        /* Retry after a failed predecessor; each caller still receives its own error. */
      })
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
      .catch(() => {
        /* Metadata retry must not inherit a previous delivery failure. */
      })
      .then(async () => {
        if (!Number.isSafeInteger(update.sequence) || update.sequence < 1)
          throw new Error('Invalid chat metadata sequence')
        if (typeof update.storeId !== 'string' || !update.storeId)
          throw new Error('Chat metadata update names no store')
        let progress = await metadataProgress(key)
        // Counted in another database: positions are not comparable. Re-read.
        if (progress?.store_id && progress.store_id !== update.storeId) {
          await recoverMetadataNow(computerId, key, true)
          progress = await metadataProgress(key)
        } else if (update.sequence > (progress?.sequence ?? 0) + 1) {
          await recoverMetadataNow(computerId, key)
          progress = await metadataProgress(key)
        }
        if (update.sequence > (progress?.sequence ?? 0)) await applyMetadata(computerId, update)
        else {
          const owner = await ownership.get(key)
          if (
            owner?.computerId !== computerId ||
            owner.epoch !== update.epoch ||
            owner.state !== 'active'
          )
            throw new Error('Stale metadata owner')
          // A consumed position is proof of nothing by itself. With a receipt
          // the hub applied this very update (its ack was lost). Without one,
          // the computer's counter went back (restored from a backup): this is
          // a different update, never acked and dropped — re-read in full.
          // The re-read holds the computer's whole current state, so the
          // update is covered either way (still pending, or already gone).
          if (!(await hasReceipt(key, update.operationId)))
            await recoverMetadataNow(computerId, key, true)
        }
        await opts.request(computerId, {
          kind: 'ackMetadata',
          id: key,
          operationId: update.operationId
        })
        // Kept (bounded) once confirmed: a late duplicate of this update — a live
        // notification racing a drain that already acked it — is recognized
        // instead of read as a rollback.
        await db.batchTxn([
          {
            type: 'run',
            sql: 'UPDATE chat_metadata_receipts SET acked=1 WHERE conversation_id=? AND operation_id=?',
            params: [key, update.operationId]
          },
          {
            type: 'run',
            sql: `DELETE FROM chat_metadata_receipts WHERE conversation_id=? AND acked=1 AND operation_id NOT IN(
              SELECT operation_id FROM chat_metadata_receipts WHERE conversation_id=? AND acked=1
              ORDER BY sequence DESC,rowid DESC LIMIT ${ACKED_RECEIPTS_KEPT})`,
            params: [key, key]
          }
        ])
      })
      .finally(() => {
        if (metadataChains.get(key) === next) metadataChains.delete(key)
      })
    metadataChains.set(key, next)
    return next
  }
  /**
   * `skip`: conversations whose migration to this computer is still unfinished
   * (recovery isolated its failure). Their destination may hold them only as
   * prepared, so active metadata must not be requested from it yet.
   */
  async function drainMetadata(
    computerId: string,
    restore = false,
    skip: ReadonlySet<string> = new Set(),
    /**
     * Restore only: each conversation's metadata counter and task state version
     * from the computer's inventory. A conversation needs no snapshot when the hub
     * applied every counted update AND its last snapshot saw this state version.
     * Missing values (an older computer, or not yet snapshotted by this hub) mean
     * a snapshot. Returns the re-read conversations: a client may show stale
     * metadata for those.
     */
    inventory?: ReadonlyMap<
      string,
      { metadataCounter?: number; stateVersion?: number; storeId?: string }
    >,
    /**
     * The conversation whose write triggered this drain: its own failure still
     * fails that write. Any other conversation's failure is logged and its
     * update stays pending for the next drain.
     */
    own?: string
  ): Promise<Set<string>> {
    const restored = new Set<string>(),
      failed = new Set<string>()
    let ownFailure: Error | undefined
    if (restore) {
      const owners = await db.all<{
        id: string
        consumed: number | null
        store_id: string | null
      }>(
        `SELECT o.id,p.sequence AS consumed,p.store_id FROM chat_ownership o
          LEFT JOIN chat_metadata_progress p ON p.conversation_id=o.id
          WHERE o.computer_id=? AND o.state='active' AND NOT EXISTS(
          SELECT 1 FROM chat_unavailable_owners u WHERE u.conversation_id=o.id AND u.computer_id=o.computer_id AND u.epoch=o.epoch) ORDER BY o.id`,
        [computerId]
      )
      for (const owner of owners) {
        if (skip.has(owner.id)) continue
        const reported = inventory?.get(owner.id)
        const applied = appliedStateVersions.get(owner.id)
        if (
          reported?.metadataCounter !== undefined &&
          owner.consumed !== null &&
          reported.metadataCounter === owner.consumed &&
          reported.storeId !== undefined &&
          reported.storeId === owner.store_id &&
          applied !== undefined &&
          reported.stateVersion === applied
        )
          continue
        // Isolated like an unfinished migration: one conversation whose
        // metadata the hub rejects must not fail the computer's recovery.
        if (
          await isolateItem(
            `metadata recovery of conversation ${owner.id}`,
            () => recoverMetadata(computerId, owner.id),
            (error) => {
              failed.add(owner.id)
              opts.onConversationFailure?.(computerId, owner.id, error)
            }
          )
        )
          restored.add(owner.id)
      }
    }
    for (;;) {
      const updates = (await opts.request(computerId, {
        kind: 'pendingMetadata'
      })) as ChatMetadataUpdate[]
      updates.sort(
        (a, b) => a.conversationId.localeCompare(b.conversationId) || a.sequence - b.sequence
      )
      let applied = 0
      for (const update of updates) {
        // A failed conversation's later updates stay pending (in order) for its
        // next drain instead of failing every other conversation's.
        if (failed.has(update.conversationId)) continue
        if (
          await isolateItem(
            `metadata update of conversation ${update.conversationId}`,
            () => reconcileMetadata(computerId, update),
            (error) => {
              failed.add(update.conversationId)
              restored.delete(update.conversationId)
              if (update.conversationId === own) ownFailure ??= error
              // Restore re-reads metadata: a conversation it cannot apply is
              // fenced. A live update simply stays pending and is retried.
              if (restore) opts.onConversationFailure?.(computerId, update.conversationId, error)
            }
          )
        )
          applied++
      }
      // A full page made of skipped updates would be re-served forever.
      if (updates.length < 500 || applied === 0) {
        if (ownFailure) throw ownFailure
        return restored
      }
    }
  }
  function invoke(
    target: 'ops' | 'queue',
    method: string,
    args: unknown[],
    operationId?: string
  ): Promise<unknown> {
    // Ordered per tab from the moment the call entered (no await before this).
    if (target === 'ops' && SESSION_OPENING_OPS.has(method))
      return openSession(tabIdOf(args[0]), () => invokeNow(target, method, args, operationId))
    if (target === 'ops' && method === 'send') {
      const tabId = tabIdOf(args[0])
      if (opening.has(tabId))
        return afterOpening(tabId).then(() => invokeNow(target, method, args, operationId))
    }
    return invokeNow(target, method, args, operationId)
  }
  async function invokeNow(
    target: 'ops' | 'queue',
    method: string,
    args: unknown[],
    operationId?: string
  ): Promise<unknown> {
    args = trimUnsetArgs(args)
    if (target === 'queue' && method === 'push') args = structuredClone(args)
    if (target === 'ops' && method === 'supports') return isChatSupported(String(args[0]))
    if (target === 'ops' && method === 'testSetWatchdogTimings') {
      if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
      const pc = await opts.defaultComputer()
      if (!pc) throw new Error('Test computer unavailable')
      await opts.recoverComputer?.(pc)
      return opts.request(pc, { kind: 'test.watchdog', timings: args[0] })
    }
    if (target === 'ops' && catalogMethods.has(method))
      return catalogCall(method as ChatCatalogOperation, {}, args)
    // Take the entry fence before scope/bootstrap awaits can reorder callers.
    // Push releases after its durable reservation ACK; clear/reset/stop retain
    // the fence through mutation so later user submissions survive the clear.
    const clearsQueue =
      (target === 'queue' && method === 'clear') ||
      (target === 'ops' && ['abortAndPop', 'reset', 'remove'].includes(method))
    const ordered = (target === 'queue' && method === 'push') || clearsQueue
    const first = args[0]
    const entry = ordered ? enterQueue(tabIdOf(first)) : undefined
    let owner: HubChatOwnership | undefined
    const commandId = operationId ?? randomUUID()
    let admission: QueueAdmission | undefined
    let renewal: ReturnType<typeof setInterval> | undefined
    let renewing = false
    const queueControl = (name: string, values: unknown[], id: string = randomUUID()) => {
      if (!owner?.computerId) throw new Error('Queue ownership unavailable')
      return opts.request(owner.computerId, {
        kind: 'invoke',
        value: {
          route: { id: owner.id, epoch: owner.epoch },
          target: 'queue',
          method: name,
          args: values,
          operationId: id
        }
      })
    }
    try {
      if (entry) await entry.ready
      if (
        (target === 'ops' && ['kill', 'abortAndPop'].includes(method)) ||
        (target === 'queue' && method === 'clear')
      ) {
        const tabId = tabIdOf(first)
        const existing = await ownership.forTab(tabId)
        if (existing?.computerId && opts.chatRuntimeReady?.(existing.computerId) === false) {
          await opts.gate?.(existing.computerId, existing.taskId)
          if (existing.state !== 'active')
            throw new Error('Chat stop ownership is not active during the computer update')
          const call = parseChatInvocation({
            route: { id: existing.id, epoch: existing.epoch },
            target,
            method,
            args,
            operationId: commandId
          })
          const context = call.args[0]
          if (
            context &&
            typeof context === 'object' &&
            'tabId' in context &&
            (context.tabId !== existing.tabId ||
              !('taskId' in context) ||
              context.taskId !== existing.taskId ||
              !('mode' in context) ||
              context.mode !== existing.mode)
          )
            throw new Error('Chat stop ownership mismatch')
          const stop = opts.stopRequest ?? opts.request
          const request = (stopTarget: 'ops' | 'queue', stopMethod: string, id: string) =>
            stop(existing.computerId!, {
              kind: 'invoke',
              value: {
                route: call.route,
                target: stopTarget,
                method: stopMethod,
                args: [existing.tabId],
                operationId: id
              }
            })
          if (method === 'clear') return request('queue', 'clear', commandId)
          if (method === 'abortAndPop')
            await request(
              'queue',
              'clear',
              createHash('sha256')
                .update('maintenance-stop-clear:' + commandId)
                .digest('hex')
            )
          const result = await request('ops', 'kill', commandId)
          // The old abort operation may spawn a new process. Only stop here;
          // retain the in-flight user message for the replacement host to read.
          return method === 'abortAndPop'
            ? { popped: false, text: null, id: null, content: null }
            : result
        }
      }
      owner = await route(target, method, args)
      if (target === 'ops' && ['getTabState', 'saveTabDraft', 'saveTabScroll'].includes(method))
        assertChatTabStateScope(
          owner,
          args[method === 'getTabState' ? 1 : 2] as ChatTabStateScope | undefined
        )
      if (target === 'queue' && method === 'push') {
        const expectedMode = (args[3] as ChatQueuePushOptions | undefined)?.expectedMode
        if (expectedMode !== undefined && expectedMode !== owner.mode)
          throw new Error(
            'Chat provider changed before queue admission; message was not submitted.'
          )
      }
      if (target !== 'ops' || !historyReadMethods.has(method)) await sync(owner)
      if (target === 'queue' && method === 'push') {
        // Reserve order before transferring files. Later requests can commit
        // behind this slot, but the computer cannot drain past its pending head.
        const inputHash = createHash('sha256').update(JSON.stringify(args)).digest('hex')
        const key = createHash('sha256').update(commandId).digest('hex')
        const supplied = structuredClone((args[3] ?? {}) as ChatQueuePushOptions)
        const id = supplied.id ?? commandId
        const reservationId = createHash('sha256')
          .update('queue-reserve:' + commandId)
          .digest('hex')
        admission = (await queueControl(
          'reserve',
          [owner.tabId, id, key, inputHash],
          reservationId
        )) as QueueAdmission
        args[3] = { ...supplied, id, admission: { key: admission.key, token: admission.token } }
        renewal = setInterval(() => {
          if (renewing) return
          renewing = true
          void queueControl('renewReservation', [
            owner!.tabId,
            { key: admission!.key, token: admission!.token }
          ])
            .catch(() => {
              /* Expired leases are fenced by the final push. */
            })
            .finally(() => {
              renewing = false
            })
        }, 30_000)
        renewal.unref?.()
        entry?.release()
      }
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
          ...(!read ? { operationId: commandId } : {})
        }
      })
      if (!read) {
        await drainMetadata(owner.computerId!, false, undefined, undefined, owner.id)
        if (['continueInTerminal', 'releaseConversation', 'remove', 'kill'].includes(method))
          // The operation already succeeded on the computer: a failed mirror refresh
          // never fails it. The next maintenance pass (reconnect, 60 s) refreshes again.
          await refreshSessions(owner.computerId!).catch((error: unknown) => {
            console.error('[chat] session list refresh failed after', method, error)
          })
      }
      return result
    } catch (error) {
      if (admission) {
        const cancellationId = createHash('sha256')
          .update('queue-cancel:' + commandId)
          .digest('hex')
        await queueControl(
          'cancelReservation',
          [owner!.tabId, { key: admission.key, token: admission.token }],
          cancellationId
        ).catch(() => {
          /* The computer's bounded lease also releases a lost caller. */
        })
      }
      throw error
    } finally {
      if (renewal) clearInterval(renewal)
      entry?.release()
    }
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
    // A folder list runs inside one task's own folders on the computer (§9 Phase
    // 7c): with no chat of the task open yet, name the task (and its project).
    const taskId = owner?.taskId ?? context.taskId
    const project =
      !owner && taskId
        ? await db.get<{ project_id: string | null }>('SELECT project_id FROM tasks WHERE id=?', [
            taskId
          ])
        : undefined
    return opts.request(computerId, {
      kind: 'catalog',
      method,
      args: trimUnsetArgs(args),
      operationId: randomUUID(),
      ...(owner ? { route: { id: owner.id, epoch: owner.epoch } } : {}),
      ...(project ? { scope: { taskId: taskId!, projectId: project.project_id } } : {})
    })
  }
  async function refreshSessions(computerId: string) {
    const rows = (await opts.request(computerId, { kind: 'sessions' })) as Array<
      ChatSessionStateEntry & { providerSessionId?: string | null }
    >
    if (!Array.isArray(rows)) throw new Error('Invalid computer session list')
    const accepted: Array<ChatSessionStateEntry & { providerSessionId?: string | null }> = []
    // One row the hub cannot place (malformed, or its ownership lookup fails) is
    // left out of the mirror on its own; every other session is still listed.
    await forEachIsolated(
      rows,
      {
        pass: 'hub-session-refresh',
        key: (row) => String(row?.sessionId),
        ledger: createAsyncFaultLedger(db, { origin: 'hub', computerId }),
        ignoreGate: true,
        isFatal: isComputerUnreachable
      },
      async (row) => {
        if (
          !row ||
          typeof row.sessionId !== 'string' ||
          typeof row.taskId !== 'string' ||
          !row.sessionId.startsWith(row.taskId) ||
          row.sessionId.length <= row.taskId.length + 1
        )
          throw new StructuralFaultError('Invalid computer session entry')
        const tabId = row.sessionId.slice(row.taskId.length + 1),
          owner = await ownership.forTab(tabId)
        if (
          owner?.computerId !== computerId ||
          owner.taskId !== row.taskId ||
          owner.state !== 'active'
        )
          return
        accepted.push(row)
      }
    )
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
          await invoke('ops', 'releaseConversation', [
            row.sessionId.slice(taskId.length + 1),
            providerSessionId
          ])
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
    /**
     * Settings of the task's chats changed on their computer without a client's own
     * write (the hub's staged settings were imported there): clients re-read them.
     */
    settingsChanged(taskId: string) {
      events.emit('settings-changed', taskId)
    },
    /** Relayed-event progress, compared with the computer's at recovery. */
    history,
    async notifyReplayRequired(
      computerId: string,
      conversations: ReadonlySet<string>,
      generation: (conversationId: string, epoch: number) => string
    ) {
      // History stays on the computer. Signal only current, available bindings of
      // the conversations that changed; subscribers fetch their authorized timeline
      // instead of replaying content through a hub journal. Include idle/finished
      // chats, not only live sessions.
      const tabs = await db.all<{ tab_id: string; conversation_id: string; epoch: number }>(
        `SELECT b.tab_id,b.conversation_id,o.epoch FROM chat_tab_bindings b
          JOIN chat_ownership o ON o.id=b.conversation_id
          JOIN terminal_tabs t ON t.id=b.tab_id AND t.task_id=o.task_id
          LEFT JOIN chat_task_lifecycle l ON l.task_id=o.task_id
          WHERE o.computer_id=? AND o.state='active'
          AND (l.state IS NULL OR l.state<>'deleted')
          AND NOT EXISTS(SELECT 1 FROM chat_unavailable_owners u
            WHERE u.conversation_id=o.id AND u.computer_id=o.computer_id AND u.epoch=o.epoch)`,
        [computerId]
      )
      for (const tab of tabs)
        if (conversations.has(tab.conversation_id))
          events.emit('replay-required', tab.tab_id, generation(tab.conversation_id, tab.epoch))
    },
    async resetCaches() {
      await Promise.allSettled([...taskMigrations.values(), ...metadataChains.values()])
      sessionMirror.clear()
      taskMigrations.clear()
      history.clear()
      appliedStateVersions.clear()
    },
    invoke,
    ensureTab,
    ensureTask,
    ensurePromptTask,
    initializeOwner: initialize,
    resumeProviderTransitions: providerTransitions.resume,
    recoverProviderTransitions: providerTransitions.recover,
    async resumeInitializations(computerId: string) {
      // An initialization that fails stays reserved: opening its chat retries it
      // and shows the error there.
      for (const owner of await ownership.pendingBootstraps(computerId))
        await isolateItem(`initialization of conversation ${owner.id}`, () => initialize(owner))
    },
    /**
     * Chats on this computer whose task still carries hub starting values for
     * their mode (one migrated, or seeded while it was initializing): bootstrap
     * them again, so the computer holds its own values and the hub copy goes.
     */
    async settleStartingValues(computerId: string) {
      const keys = COMPUTER_OWNED_CHAT_KEYS.map(
        (key) => `json_type(t.provider_config,'$.'||json_quote(o.mode)||'.${key}') IS NOT NULL`
      ).join(' OR ')
      const owners = await db.all<{ id: string }>(
        `SELECT o.id FROM chat_ownership o JOIN tasks t ON t.id=o.task_id
          WHERE o.computer_id=? AND o.state='active' AND json_valid(t.provider_config) AND (${keys})
          ORDER BY o.id`,
        [computerId]
      )
      for (const { id } of owners)
        await isolateItem(`chat starting values of conversation ${id}`, async () => {
          const owner = await ownership.get(id)
          if (
            owner?.state === 'active' &&
            owner.computerId === computerId &&
            !isStorageOnlyChatOwner(owner)
          )
            await sync(owner)
        })
    },
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
          // Saved events only: a live fragment repeats the seq of the saved event it follows.
          if (p.live === undefined) history.observe(owner.id, Number(p.seq))
          events.emit(
            'event',
            owner.tabId,
            p.event as AgentEvent,
            Number(p.seq),
            p.live as number | undefined,
            p.at as number | undefined
          )
          break
        case 'event-signal': {
          // Every saved event, relayed in full or not (docs/direct-link.md): what
          // hub-side consumers that are not clients rely on.
          const saved = p.saved as ChatSavedSummary
          history.observe(owner.id, Number(saved.seq))
          events.emit('saved', owner.tabId, saved)
          break
        }
        case 'exit':
          sessionMirror.delete(`${owner.taskId}:${owner.tabId}`)
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
        case 'sessions-changed':
          // The computer's ledger recorded a session: the hub holds none (§9), it
          // only tells its clients to re-read.
          opts.onSessionsChanged?.(owner.taskId)
          break
        case 'pinned-messages-changed':
          events.emit('pinned-messages-changed', owner.tabId)
          break
        case 'queue-changed':
          queueEvents.emit('queue-changed', owner.tabId)
          break
        case 'queue-drained':
          queueEvents.emit('queue-drained', owner.tabId, String(p.original))
          break
        case 'state':
          if (
            p.sessionId !== `${owner.taskId}:${owner.tabId}` ||
            !['not-spawned', 'starting', 'idle', 'running', 'background', 'error', 'dead'].includes(
              String(p.newState)
            ) ||
            !['not-spawned', 'starting', 'idle', 'running', 'background', 'error', 'dead'].includes(
              String(p.oldState)
            )
          )
            throw new Error('Invalid chat state notification')
          if (p.newState !== 'not-spawned' && p.newState !== 'dead') {
            const jobs = sessionMirror.get(String(p.sessionId))?.backgroundJobs
            sessionMirror.set(String(p.sessionId), {
              sessionId: String(p.sessionId),
              taskId: owner.taskId,
              mode: owner.mode,
              state: p.newState as ChatSessionStateEntry['state'],
              lastOutputTime: Date.now(),
              computerId,
              providerSessionId: p.providerSessionId as string | null,
              ...(jobs ? { backgroundJobs: jobs } : {})
            })
          } else sessionMirror.delete(String(p.sessionId))
          await opts.onState?.(
            String(p.sessionId),
            p.newState as ChatTerminalState,
            p.oldState as ChatTerminalState,
            p.hasUserInput === true
          )
          break
        case 'background-jobs': {
          const count = p.count
          if (
            p.sessionId !== `${owner.taskId}:${owner.tabId}` ||
            typeof count !== 'number' ||
            !Number.isInteger(count) ||
            count < 0
          )
            throw new Error('Invalid chat background-jobs notification')
          const row = sessionMirror.get(String(p.sessionId))
          if (row) {
            const { backgroundJobs: _previous, ...rest } = row
            sessionMirror.set(
              String(p.sessionId),
              count > 0 ? { ...rest, backgroundJobs: count } : rest
            )
          }
          await opts.onBackgroundJobs?.(String(p.sessionId), count)
          break
        }
      }
    }
  }
}
