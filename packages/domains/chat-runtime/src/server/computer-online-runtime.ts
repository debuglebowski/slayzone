/** Online controller. All native/composed storage lives on its canonical worker. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { relative, join, isAbsolute, sep } from 'node:path'
import { deserializeError } from '@slayzone/platform/sqlite-worker'
import {
  createChatTransport,
  createConversationRegistry,
  createChatOps,
  createChatQueueRuntime
} from '@slayzone/terminal/runtime'
import { parseChatInvocation, type ChatTabTransition, type ConversationIdentity } from '../shared'
import type { ChatBootstrap } from './local-data'
import type { ComputerChatRuntimeOptions } from './computer-runtime'
import { openChatStorageOwner } from './storage-owner'
import { createComputerStoreClient } from './computer-store-client'
import { createChatInvoker } from './invocation'
import { createChatTaskAdmission } from './task-admission'
import type { OnlineStoreData, HostCall, StoreNotification } from './computer-store-protocol'

export type OpenComputerChatRuntimeOptions = Omit<
  ComputerChatRuntimeOptions,
  'maintenance' | 'dataImports' | 'blobBackfill' | 'markerBackfill' | 'compaction'
> &
  OnlineStoreData & { workerPath: string }

export async function openComputerChatRuntime(opts: OpenComputerChatRuntimeOptions) {
  let closing: Promise<void> | null = null,
    stopped = false,
    failure: Error | null = null
  const context = new AsyncLocalStorage<string>()
  const publication = new AsyncLocalStorage<ConversationIdentity>()
  const bindings = new Map<string, ConversationIdentity>()
  let publicationVersion = 0
  const bind = (identity: ConversationIdentity) => {
    bindings.set(identity.tabId, identity)
  }
  const forgetTask = (taskId: string) => {
    for (const [tab, identity] of bindings) if (identity.taskId === taskId) bindings.delete(tab)
  }
  const locks = new Map<
    string,
    {
      taskId: string
      tabId: string
      conversationId: string
      done: Promise<void>
      release(): void
      info: ReturnType<ReturnType<typeof createChatTransport>['getSessionInfo']>
    }
  >()
  const lockedTasks = new Map<string, Promise<void>>()
  const lockedTabs = new Map<string, string>()
  const active = new Map<string, Set<{ conversationId: string; done: Promise<void> }>>()
  const tagged = new Map<string, Set<Promise<unknown>>>()
  let onFailureAdmission: { close(): void } | undefined
  const latchFailure = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error))
    // Revoke permits already awaiting preparation, without releasing physical leases.
    onFailureAdmission?.close()
  }
  let hostCall: ((request: HostCall) => Promise<unknown>) | null = null
  let notification: ((value: StoreNotification) => void) | null = null
  const storage = await openChatStorageOwner({
    stateDir: opts.stateDir,
    hubScope: opts.hubScope,
    workerPath: opts.workerPath,
    online: {
      computerId: opts.computerId,
      hostTurnGit: !!opts.turnGit,
      hostHeal: !!opts.healIo,
      blobBackfill: opts.blobBackfill,
      markerBackfill: opts.markerBackfill,
      compaction: opts.compaction
    },
    onHostRequest: async (request) => {
      if (hostCall) return hostCall(request)
      if (request.group === 'quiesce') return false
      throw new Error('Online controller is not ready')
    },
    onStoreNotification: (value) => notification?.(value),
    onUnexpectedExit: (error) => {
      latchFailure(error)
      for (const lock of locks.values()) lock.release()
    }
  })
  try {
    if (failure) throw failure
    const taskAdmission = createChatTaskAdmission(async (taskId) => {
      while (lockedTasks.has(taskId)) await lockedTasks.get(taskId)
      if (failure || stopped || closing) throw failure ?? new Error('Chat runtime is shutting down')
      await remote.control.taskActive(taskId)
    })
    onFailureAdmission = taskAdmission
    const remote = createComputerStoreClient(storage, {
      before: (group, method, args) => {
        if (
          (group === 'local' && method === 'bootstrap') ||
          (group === 'control' &&
            ['applyLifecycle', 'deleteConversation', 'prepareErasure', 'relocateProject'].includes(
              method
            )) ||
          (group === 'transfers' && method === 'finish') ||
          (group === 'sessionMoves' && ['exportTask', 'forgetTask'].includes(method)) ||
          (group === 'requests' &&
            ['migration.activate', 'sessionMove.forget'].includes(
              (args[0] as { kind?: string })?.kind ?? ''
            ))
        )
          publicationVersion++
      },
      resumeToken: (group, method, args) =>
        context.getStore() ??
        ((group === 'timeline' ||
          (group === 'local' && method.startsWith('data.')) ||
          (group === 'control' && method === 'agentState')) &&
        typeof args[0] === 'string'
          ? lockedTabs.get(args[0])
          : undefined),
      issued(work, token) {
        if (!token) return
        let set = tagged.get(token)
        if (!set) {
          set = new Set()
          tagged.set(token, set)
        }
        set.add(work)
        void work.then(
          () => set!.delete(work),
          () => set!.delete(work)
        )
      }
    })
    const drain = async (token: string) => {
      // A completed reader open can enqueue its first bounded page in a microtask.
      // isolation: fatal — One lease barrier must retain admission until every accepted operation drains.
      while (tagged.get(token)?.size) await Promise.allSettled([...(tagged.get(token) ?? [])])
    }
    const local = remote.local
    const conversations = createConversationRegistry()
    const transitions = new Set<string>()
    const transitionPromises = new Map<string, Promise<ChatTabTransition['to']>>()
    const userInputSessions = new Set<string>()
    const backend = opts.transport?.backend
    const transport = createChatTransport(
      {
        ...opts.transport,
        beforeSpawn: async (tabId) => {
          const owner = await remote.control.spawnOwner(tabId)
          bind(owner.identity)
          if (taskAdmission.blocked(owner.identity.taskId) || transitions.has(tabId))
            throw new Error('Task work admission is closed')
          await opts.transport?.beforeSpawn?.(tabId)
        },
        userInputTracker: {
          mark: (id) => {
            userInputSessions.add(id)
          },
          clear: (id) => {
            userInputSessions.delete(id)
          },
          has: (id) => userInputSessions.has(id)
        },
        diagnostic: (tabId, event) => {
          void remote.control.diagnostic(tabId, event).then(
            (saved) => {
              if (saved) opts.transport?.diagnostic?.(tabId, event)
            },
            (error) => {
              latchFailure(error)
            }
          )
        },
        ...(backend
          ? {
              backend: new Proxy(backend, {
                get(target, key) {
                  if (key === 'spawn')
                    return async (spec: Parameters<typeof backend.spawn>[0]) => {
                      const permit = await taskAdmission.acquire(spec.taskId)
                      try {
                        permit.assert()
                        return await backend.spawn(spec)
                      } finally {
                        permit.release()
                      }
                    }
                  const value = Reflect.get(target, key, target)
                  return typeof value === 'function' ? value.bind(target) : value
                }
              })
            }
          : {}),
        attachmentReader: remote.attachments.reader,
        workspaceStore: remote.workspaceStore
      },
      conversations
    )
    const queueRuntime = createChatQueueRuntime({
      ...transport,
      ensureSpawned: async (tabId) => {
        if (transitions.has(tabId) || lockedTabs.has(tabId))
          throw new Error('Chat provider transition is pending')
        return transport.ensureSpawned(tabId)
      },
      dispatchUserMessage: async (tabId, message) => {
        if (transitions.has(tabId) || lockedTabs.has(tabId))
          throw new Error('Chat provider transition is pending')
        await remote.control.spawnOwner(tabId)
        if (transitions.has(tabId) || lockedTabs.has(tabId))
          throw new Error('Chat provider transition is pending')
        return transport.dispatchUserMessage(tabId, message)
      },
      getSessionTerminalState: (tabId) =>
        transitions.has(tabId) || lockedTabs.has(tabId)
          ? null
          : transport.getSessionTerminalState(tabId),
      isReadyForQueuedMessage: (tabId) =>
        !transitions.has(tabId) &&
        !lockedTabs.has(tabId) &&
        transport.isReadyForQueuedMessage(tabId)
    })
    const ops = createChatOps({
      dataOps: local.data,
      sessionReader: opts.sessionReader,
      onStateChange: opts.transport?.onStateChange,
      transport,
      conversations,
      notifyQueueChanged: queueRuntime.notifyChatQueueChanged
    })
    const queueOps = queueRuntime.createChatQueueOps(null, local.queue, local.data.attachments)
    const invoke = createChatInvoker({ storage, local, ops, queueOps })
    const changed = (tabId: string) => {
      queueRuntime.notifyChatQueueChanged(tabId)
      transport.chatEvents.emit('threads-changed', tabId)
      transport.chatEvents.emit('pinned-messages-changed', tabId)
    }
    notification = (message) => {
      if (stopped || closing) return
      if (message.type === 'metadata') opts.onMetadata?.(message.update)
      else if (message.type === 'sessions') {
        if (message.owner)
          publication.run(message.owner, () =>
            transport.chatEvents.emit('sessions-changed', message.tabId)
          )
      } else if (message.type === 'changed') {
        if (message.owner) publication.run(message.owner, () => changed(message.tabId))
      } else if (message.type === 'log') opts.log?.(message.line)
      else if (message.type === 'failure') {
        latchFailure(deserializeError(message.error))
      }
    }
    hostCall = async (request) => {
      if (request.group === 'turnGit' || request.group === 'heal') {
        const target = request.group === 'turnGit' ? opts.turnGit : opts.healIo
        if (!target)
          throw new Error(
            request.group === 'turnGit'
              ? 'Agent turns are unavailable on this computer'
              : 'Conversation heal is unavailable on this computer'
          )
        const method = target[request.method as keyof typeof target] as (
          ...args: unknown[]
        ) => unknown
        return Reflect.apply(method, target, request.args)
      }
      if (request.group === 'test-tab') {
        if (process.env.PLAYWRIGHT !== '1') throw new Error('Test-only host control unavailable')
        if (request.action === 'busy') return !!transport.getSessionInfo(request.tabId)?.pid
        return transport.removeSession(request.tabId)
      }
      if (request.group === 'quiesce') {
        const { owner, token } = request,
          i = owner.identity
        const info = transport.getSessionInfo(i.tabId)
        if (
          closing ||
          stopped ||
          failure ||
          lockedTasks.has(i.taskId) ||
          active.has(i.taskId) ||
          taskAdmission.blocked(i.taskId) ||
          taskAdmission.busy(i.taskId) ||
          opts.hasExternalTaskWork?.(i.taskId) ||
          (info?.pid && !info.ended) ||
          transport.isTurnOpen(i.tabId) ||
          transport
            .listChatSessions()
            .some((s) => s.taskId === i.taskId && !['dead', 'error'].includes(s.state))
        )
          return false
        let resolve: () => void = () => undefined
        const done = new Promise<void>((r) => {
          resolve = r
        })
        const release = () => {
          lockedTasks.delete(i.taskId)
          lockedTabs.delete(i.tabId)
          locks.delete(token)
          tagged.delete(token)
          resolve()
        }
        locks.set(token, {
          taskId: i.taskId,
          tabId: i.tabId,
          conversationId: i.id,
          done,
          release,
          info
        })
        lockedTasks.set(i.taskId, done)
        lockedTabs.set(i.tabId, token)
        try {
          await context.run(token, () => transport.removeSession(i.tabId))
          await drain(token)
          return true
        } catch (error) {
          release()
          throw error
        }
      }
      const lock = locks.get(request.token)
      if (!lock) return
      try {
        if (
          request.resume &&
          !closing &&
          !stopped &&
          !failure &&
          !taskAdmission.blocked(lock.taskId) &&
          lock.info
        ) {
          const info = lock.info
          await context.run(request.token, () =>
            ops.hydrate({ taskId: info.taskId, tabId: lock.tabId, mode: info.mode, cwd: info.cwd })
          )
          await drain(request.token)
        }
      } finally {
        lock.release()
      }
    }
    async function access<T>(id: string, work: () => Promise<T>): Promise<T> {
      const owner = await storage.conversation(id)
      const taskId = owner?.identity.taskId ?? id
      while (lockedTasks.has(taskId)) await lockedTasks.get(taskId)
      if (stopped || closing || failure) throw failure ?? new Error('Chat runtime is shutting down')
      if (taskAdmission.blocked(taskId)) throw new Error('Task work admission is closed')
      let finish!: () => void
      const call = {
        conversationId: id,
        done: new Promise<void>((resolve) => {
          finish = resolve
        })
      }
      let calls = active.get(taskId)
      if (!calls) {
        calls = new Set()
        active.set(taskId, calls)
      }
      calls.add(call)
      try {
        return await work()
      } finally {
        calls.delete(call)
        if (!calls.size) active.delete(taskId)
        finish()
      }
    }
    function drainCalls(taskId?: string, conversationId?: string) {
      // Admission is closed by the caller before this snapshot; accepted callbacks
      // retain their owner until they finish, including reads and file preparation.
      const calls = [...active].flatMap(([task, calls]) =>
        taskId && task !== taskId
          ? []
          : [...calls]
              .filter((call) => !conversationId || call.conversationId === conversationId)
              .map((call) => call.done)
      )
      return Promise.all(calls)
    }
    async function removeTaskSessions(taskId: string) {
      const live = new Set(
        transport
          .listChatSessions()
          .filter((s) => s.taskId === taskId)
          .map((s) => s.sessionId.slice(taskId.length + 1))
      )
      const ending = [...live].map((tabId) => transport.removeSession(tabId))
      // Stop live controllers before store IO; also drain lazy hydrated projections.
      for (const owner of await storage.listForTask(taskId)) {
        if (!live.has(owner.identity.tabId))
          ending.push(transport.removeSession(owner.identity.tabId))
        live.add(owner.identity.tabId)
      }
      await Promise.all(ending)
      await Promise.all([...live].map((tabId) => queueRuntime.settleTab(tabId)))
      await drainCalls(taskId)
    }

    return {
      storage,
      transport,
      conversations,
      ops,
      queueOps,
      events: transport.chatEvents,
      queueEvents: queueRuntime.chatQueueEvents,
      ...remote,
      authority: { scope: storage.readScope },
      taskAdmission,
      publicationVersion: () => publicationVersion,
      publicationOwner(tabId: string) {
        const identity = publication.getStore() ?? bindings.get(tabId)
        return identity?.tabId === tabId ? { identity } : null
      },
      diagnosticsConfig: () => remote.control.diagnosticsConfig(),
      configureDiagnostics: (value: { enabled: boolean; verbose: boolean }) =>
        remote.control.configureDiagnostics(value),
      bootstrap: async (value: ChatBootstrap) => {
        if (closing || stopped) throw new Error('Chat runtime is shutting down')
        await local.bootstrap(value)
        bind(await local.owner(value.identity.tabId))
      },
      captureHook: remote.prompts.capture,
      prompts: remote.prompts.list,
      promptSummaries: remote.prompts.summaries,
      invoke: (input: unknown) =>
        access(parseChatInvocation(input).route.id, async () => {
          const call = parseChatInvocation(input),
            owner = await storage.conversation(call.route.id)
          if (owner?.state === 'active' && owner.identity.epoch === call.route.epoch)
            bind(owner.identity)
          return invoke(call)
        }),
      retention: {
        ...remote.retention,
        days: () => remote.control.retentionDays(),
        access,
        isPruning: (id: string) =>
          lockedTasks.has(id) ||
          [...locks.values()].some((lock) => lock.tabId === id || lock.conversationId === id)
      },
      async assertTaskActive(taskId: string) {
        const permit = await taskAdmission.acquire(taskId)
        try {
          permit.assert()
        } finally {
          permit.release()
        }
      },
      async transitionTab(value: ChatTabTransition) {
        const pending = transitionPromises.get(value.from.id)
        if (pending) return pending
        publicationVersion++
        transitions.add(value.from.tabId)
        const block = taskAdmission.block(value.from.taskId)
        const work = (async () => {
          await block.ready
          await storage.prepareTabTransition(value)
          if (await storage.getRecord(value.from.id, 'settings', `tab-transition:${value.id}`))
            return (await storage.conversation(value.from.id))!.identity
          await queueRuntime.settleTab(value.from.tabId)
          await transport.quiesceSession(value.from.tabId)
          await invoke.settle(value.from.id)
          const identity = await storage.commitTabTransition(value)
          bindings.delete(value.from.tabId)
          bind(identity)
          return identity
        })().finally(() => {
          transitions.delete(value.from.tabId)
          transitionPromises.delete(value.from.id)
          block.release()
        })
        transitionPromises.set(value.from.id, work)
        return work
      },
      async deleteConversation(identity: ConversationIdentity) {
        const block = taskAdmission.block(identity.taskId)
        try {
          const ending = transport.removeSession(identity.tabId)
          await block.ready
          await ending
          await queueRuntime.settleTab(identity.tabId)
          await drainCalls(identity.taskId, identity.id)
          const parents = await remote.control.deleteConversation(identity)
          bindings.delete(identity.tabId)
          for (const id of parents) transport.chatEvents.emit('threads-changed', id)
        } finally {
          block.release()
        }
      },
      async applyTaskLifecycle(
        taskId: string,
        state: 'active' | 'paused' | 'deleted',
        revision: number
      ) {
        const previous = await storage.taskLifecycle(taskId)
        if (previous.state === 'deleted')
          return remote.control.applyLifecycle(taskId, state, revision)
        if (previous.revision >= revision) return previous
        const block = taskAdmission.block(taskId)
        try {
          const ending = state === 'active' ? Promise.resolve() : removeTaskSessions(taskId)
          await block.ready
          await ending
          const applied = await remote.control.applyLifecycle(taskId, state, revision)
          if (applied.state !== 'active') forgetTask(taskId)
          return applied
        } finally {
          block.release()
        }
      },
      async eraseTask(taskId: string, revision: number, stopExternal?: () => Promise<void>) {
        const block = taskAdmission.block(taskId)
        try {
          const ending = removeTaskSessions(taskId)
          await block.ready
          await ending
          const applied = await remote.control.prepareErasure(taskId, revision)
          await stopExternal?.()
          await remote.control.finishErasure(taskId)
          forgetTask(taskId)
          return { taskId, revision: applied.revision, erased: true as const }
        } finally {
          block.release()
        }
      },
      async relocateProject(projectId: string, source: string, target: string) {
        const state = await remote.control.projectState(projectId)
        const sessions = state.records
          .map((r) => transport.getSessionInfo((r.value as ChatBootstrap).identity.tabId))
          .filter((v): v is NonNullable<typeof v> => !!v)
        if (sessions.some((s) => s.pid !== null && !s.ended))
          throw new Error('Stop running chat agents before relocating the project.')
        await Promise.all(sessions.map((s) => transport.removeSession(s.tabId)))
        await remote.control.relocateProject(projectId, source, target)
        for (const info of sessions) {
          const suffix = relative(source, info.cwd)
          const cwd =
            suffix === '' ||
            (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
              ? join(target, suffix)
              : info.cwd
          await ops.hydrate({ taskId: info.taskId, tabId: info.tabId, mode: info.mode, cwd })
        }
      },
      close() {
        return (closing ??= (async () => {
          taskAdmission.close()
          const errors: unknown[] = []
          const attempt = async (work: () => unknown) => {
            try {
              await work()
            } catch (error) {
              errors.push(error)
            }
          }
          await attempt(() => storage.db.namedTxn('chatStorage.prepareClose', {}))
          await attempt(() => remote.control.prepareClose())
          await attempt(() => queueRuntime.close())
          await attempt(() => transport.shutdownAll())
          await attempt(() => invoke.settleAll())
          await attempt(() => drainCalls())
          await attempt(() => storage.close())
          stopped = true
          for (const lock of locks.values()) lock.release()
          if (errors.length === 1) throw errors[0]
          if (errors.length)
            throw new AggregateError(errors, 'Chat runtime cleanup failed', { cause: errors[0] })
        })())
      }
    }
  } catch (error) {
    try {
      await storage.close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Online runtime startup cleanup failed', {
        cause: error
      })
    }
    throw error
  }
}
export type OnlineComputerChatRuntime = Awaited<ReturnType<typeof openComputerChatRuntime>>
