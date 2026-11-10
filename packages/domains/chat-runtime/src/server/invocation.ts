import { parseChatInvocation, CHAT_READ_OPERATIONS, type ChatOperation } from '../shared/protocol'
import type { createChatOps, ChatQueueRuntime } from '@slayzone/terminal/runtime'
import type { ChatStorage } from './storage'
import type { createLocalChatData } from './local-data'
import { assertChatTabStateScope, type ChatTabStateScope } from '@slayzone/terminal-contracts'

type Runtime = {
  storage: ChatStorage
  local: ReturnType<typeof createLocalChatData>
  ops: ReturnType<typeof createChatOps>
  queueOps: ReturnType<ChatQueueRuntime['createChatQueueOps']>
}
const tabOperations = new Set([
  'releaseConversation',
  'send',
  'sendToolResult',
  'respondPermission',
  'kill',
  'remove',
  'getReplay',
  'getBufferSince',
  'getInfo',
  'getTurnStatus',
  'openTimeline',
  'timelinePages',
  'searchTimeline',
  'commandTaskOutput',
  'stopCommandTask',
  'backgroundCommandTask',
  'stopSubAgent',
  'getWorkspaceChanges',
  'getWorkspaceFileDiff',
  'getTabState',
  'saveTabDraft',
  'saveTabScroll'
])
const taskOperations = new Set([
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

/** Validate ownership before touching runtime state, including when serving a cached receipt. */
export function createChatInvoker(runtime: Runtime) {
  const inFlight = new Map<string, Promise<unknown>>()
  // Side answers belong to the renderer, not durable chat history. A short,
  // bounded cache still lets a disconnected caller recover its response without
  // billing another provider request. The durable receipt fences retries after
  // eviction/restart, when the answer can no longer be delivered.
  const ephemeralResults = new Map<string, { result: unknown; at: number; bytes: number }>()
  let ephemeralBytes = 0
  const expireEphemeral = () => {
    for (const [key, entry] of ephemeralResults) {
      if (
        entry.at + 300_000 > Date.now() &&
        ephemeralBytes <= 4 * 1024 * 1024 &&
        ephemeralResults.size <= 100
      )
        break
      ephemeralResults.delete(key)
      ephemeralBytes -= entry.bytes
    }
  }
  const invoke = async function (input: unknown): Promise<unknown> {
    const req = parseChatInvocation(input),
      owner = runtime.storage.conversation(req.route.id)
    if (!owner || owner.identity.epoch !== req.route.epoch)
      throw new Error('Chat ownership epoch mismatch')
    if (owner.state !== 'active') throw new Error(`Chat conversation ${owner.state}`)
    if (req.method === 'testSetWatchdogTimings' && process.env.PLAYWRIGHT !== '1')
      throw new Error('Test-only chat operation unavailable')
    if (req.target === 'queue' && req.method === 'push') {
      const expectedMode = (req.args[3] as { expectedMode?: string } | undefined)?.expectedMode
      if (expectedMode !== undefined && expectedMode !== owner.identity.mode)
        throw new Error('Chat provider changed before queue admission; message was not submitted.')
    }
    const first = req.args[0],
      identity = owner.identity
    if (first && typeof first === 'object' && !Array.isArray(first) && 'tabId' in first) {
      const context = first as { tabId: unknown; taskId: unknown; mode: unknown }
      if (
        context.tabId !== identity.tabId ||
        ('taskId' in first && context.taskId !== identity.taskId) ||
        ('mode' in first && context.mode !== identity.mode)
      )
        throw new Error('Chat tab ownership mismatch')
    }
    if (req.target === 'ops') {
      if (tabOperations.has(req.method) && first !== identity.tabId)
        throw new Error('Chat tab ownership mismatch')
      if (
        taskOperations.has(req.method) &&
        (first !== identity.taskId || req.args[1] !== identity.mode)
      )
        throw new Error('Chat task ownership mismatch')
    } else if (
      ['list', 'push', 'clear', 'reserve', 'renewReservation', 'cancelReservation'].includes(
        req.method
      )
    ) {
      if (first !== identity.tabId) throw new Error('Chat queue tab ownership mismatch')
    } else {
      // `[itemId, …, tabId]`: the hub routed by the named tab, which must be this
      // conversation's. The queue ops then find nothing for an item another tab
      // holds (as for one already sent): its existence is not disclosed.
      if (req.args[req.args.length - 1] !== identity.tabId)
        throw new Error('Chat queue tab ownership mismatch')
    }
    const target = req.target === 'ops' ? runtime.ops : runtime.queueOps
    if (
      req.target === 'ops' &&
      ['getTabState', 'saveTabDraft', 'saveTabScroll'].includes(req.method)
    )
      assertChatTabStateScope(
        identity,
        req.args[req.method === 'getTabState' ? 1 : 2] as ChatTabStateScope | undefined
      )
    const operation = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[
      req.method
    ]
    if (typeof operation !== 'function') throw new Error('Chat operation unavailable')
    const read =
      req.target === 'queue'
        ? req.method === 'list'
        : CHAT_READ_OPERATIONS.has(req.method as ChatOperation)
    if (
      !read &&
      !['kill', 'remove'].includes(req.method) &&
      runtime.storage.getRecord(identity.id, 'settings', 'tab-transition-pending')
    )
      throw new Error('Chat provider transition is pending')
    if (
      runtime.storage.taskLifecycle(identity.taskId).state !== 'active' &&
      !read &&
      !['hydrate', 'kill', 'remove'].includes(req.method)
    )
      throw new Error('Task chat is paused or deleted')
    if (read) return operation(...req.args)
    if (
      runtime.ops.getInfo(identity.tabId)?.storageUnavailable &&
      !['restart', 'reset', 'remove', 'kill', 'interrupt'].includes(req.method)
    )
      throw new Error('Chat storage is unavailable. Restart chat after fixing storage.')
    const operationId = req.operationId!,
      flightKey = JSON.stringify([identity.id, operationId])
    const accepted = runtime.storage.acceptCommand(identity.id, identity.epoch, operationId, {
      target: req.target,
      method: req.method,
      args: req.args
    })
    if (accepted === 'duplicate') {
      const running = inFlight.get(flightKey)
      if (running) return running
      const previous = runtime.storage.receipt(identity.id, operationId)!
      if (req.method === 'askSideQuestion' && previous.state === 'delivered') {
        expireEphemeral()
        const cached = ephemeralResults.get(flightKey)
        if (cached) return cached.result
        throw new Error('Ephemeral operation result is unavailable; operation was not repeated')
      }
      if (previous.resultExpired)
        throw new Error('Operation result expired under chat retention; operation was not repeated')
      if (previous.state === 'delivered') return previous.result
      throw new Error(
        'Operation acceptance is durable but completion is unconfirmed; reconcile state before an explicit retry'
      )
    }
    const run = Promise.resolve()
      .then(() => operation(...req.args))
      .then((result) => {
        const saved = result ?? null
        const ephemeral = req.method === 'askSideQuestion'
        runtime.storage.completeCommand(
          identity.id,
          identity.epoch,
          operationId,
          ephemeral ? null : saved
        )
        if (ephemeral) {
          const bytes = Buffer.byteLength(JSON.stringify(saved))
          ephemeralResults.set(flightKey, { result: saved, at: Date.now(), bytes })
          ephemeralBytes += bytes
          expireEphemeral()
        }
        return saved
      })
    inFlight.set(flightKey, run)
    void run.then(
      () => inFlight.delete(flightKey),
      () => inFlight.delete(flightKey)
    )
    return run
  }
  return Object.assign(invoke, {
    settle: async (conversationId: string) => {
      await Promise.allSettled(
        [...inFlight]
          .filter(([key]) => (JSON.parse(key) as string[])[0] === conversationId)
          .map(([, work]) => work)
      )
    }
  })
}
