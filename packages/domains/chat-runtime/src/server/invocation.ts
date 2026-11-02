import { parseChatInvocation, CHAT_READ_OPERATIONS, type ChatOperation } from '../shared/protocol'
import type { createChatOps, ChatQueueRuntime } from '@slayzone/terminal/runtime'
import type { ChatStorage } from './storage'
import type { createLocalChatData } from './local-data'

type Runtime = {
  storage: ChatStorage
  local: ReturnType<typeof createLocalChatData>
  ops: ReturnType<typeof createChatOps>
  queueOps: ReturnType<ChatQueueRuntime['createChatQueueOps']>
}
const tabOperations = new Set([
  'send',
  'sendToolResult',
  'respondPermission',
  'kill',
  'remove',
  'getReplay',
  'getBufferSince',
  'getInfo',
  'openTimeline',
  'timelinePages',
  'searchTimeline',
  'commandTaskOutput',
  'stopCommandTask',
  'backgroundCommandTask',
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
  return async function invoke(input: unknown): Promise<unknown> {
    const req = parseChatInvocation(input),
      owner = runtime.storage.conversation(req.route.id)
    if (!owner || owner.identity.epoch !== req.route.epoch)
      throw new Error('Chat ownership epoch mismatch')
    if (owner.state !== 'active') throw new Error(`Chat conversation ${owner.state}`)
    if (req.method === 'testSetWatchdogTimings' && process.env.PLAYWRIGHT !== '1')
      throw new Error('Test-only chat operation unavailable')
    const first = req.args[0],
      identity = owner.identity
    if (first && typeof first === 'object' && !Array.isArray(first) && 'tabId' in first) {
      const context = first as { tabId: unknown; taskId: unknown; mode: unknown }
      if (
        context.tabId !== identity.tabId ||
        context.taskId !== identity.taskId ||
        context.mode !== identity.mode
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
    } else if (['list', 'push', 'clear'].includes(req.method)) {
      if (first !== identity.tabId) throw new Error('Chat queue tab ownership mismatch')
    } else {
      const tab = await runtime.local.queue.getTabIdForItem(first as string)
      if (tab && tab !== identity.tabId) throw new Error('Chat queue item ownership mismatch')
    }
    const target = req.target === 'ops' ? runtime.ops : runtime.queueOps
    const operation = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[
      req.method
    ]
    if (typeof operation !== 'function') throw new Error('Chat operation unavailable')
    const read =
      req.target === 'queue'
        ? req.method === 'list'
        : CHAT_READ_OPERATIONS.has(req.method as ChatOperation)
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
      if (previous.state === 'delivered') return previous.result
      throw new Error(
        'Operation acceptance is durable but completion is unconfirmed; reconcile state before an explicit retry'
      )
    }
    const run = Promise.resolve()
      .then(() => operation(...req.args))
      .then((result) => {
        const saved = result ?? null
        runtime.storage.completeCommand(identity.id, identity.epoch, operationId, saved)
        return saved
      })
    inFlight.set(flightKey, run)
    void run.then(
      () => inFlight.delete(flightKey),
      () => inFlight.delete(flightKey)
    )
    return run
  }
}
