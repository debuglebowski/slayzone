/**
 * Test-only (the chat's jest suites; never imported by app code): an in-memory hub for
 * `ChatSession` — every `chat.*` procedure and subscription it uses, with answers a
 * test can replace, every call recorded, and `emit` to push what a hub would send.
 * Run through the real tRPC client and React Query (`trpcTest`, `../testing.tsx`).
 */
import type { TrpcTestBackend } from '@slayzone/transport/testing'

// biome-ignore lint/suspicious/noExplicitAny: inputs are whatever the view under test sends
type Handler = (input: any) => unknown

export interface FakeHub {
  backend: TrpcTestBackend
  /** Every query / mutation, in order. */
  // biome-ignore lint/suspicious/noExplicitAny: inputs are whatever the view under test sends
  calls: Array<{ path: string; input: any }>
  /** Inputs each subscription was started with. */
  subscribed: Record<string, unknown[]>
  /** Replace a procedure's answer. */
  on: (path: string, handler: Handler) => void
  /** Push data to every live subscription of `path`. */
  emit: (path: string, data: unknown) => void
  /** Start every live subscription of `path` again (what a reconnect does). */
  restart: (path: string) => void
  // biome-ignore lint/suspicious/noExplicitAny: inputs are whatever the view under test sends
  callsTo: (path: string) => any[]
}

export function fakeHub(opts: {
  tabId: string
  taskId: string
  /** The tab's session on the hub; null = none yet. */
  session?: { taskId: string; cwd: string } | null
  task?: Record<string, unknown> | null
  projects?: Array<Record<string, unknown>>
}): FakeHub {
  const calls: FakeHub['calls'] = []
  const subscribed: Record<string, unknown[]> = {}
  const live = new Map<
    string,
    Set<{ emit: (d: unknown) => void; input: unknown; restart: () => void }>
  >()
  const emptyReplay = { events: [], live: { afterSeq: -1, liveSeq: 0, events: [] } }
  const handlers: Record<string, Handler> = {
    'chat.getInfo': () => opts.session ?? null,
    'task.get': () =>
      opts.task === undefined
        ? {
            id: opts.taskId,
            project_id: 'p1',
            worktree_path: null,
            base_dir: null,
            repo_name: null
          }
        : opts.task,
    'projects.list': () =>
      opts.projects ?? [
        {
          id: 'p1',
          selected_repo: null,
          placements: [{ computer_id: 'c1', path: '/proj', status: 'ready' }],
          resolved_computer_id: 'c1'
        }
      ],
    'worktrees.detectChildRepos': () => [],
    'chat.hydrate': () => null,
    'chat.getReplay': () => emptyReplay,
    'chat.send': (input) => ({ id: input.message?.id ?? 'x', state: 'queued' }),
    'chat.respondPermission': () => true,
    'chat.interrupt': () => null,
    'chat.abortAndPop': () => ({ popped: false, text: null, id: null, content: null }),
    'chat.takeOver': () => null,
    'chat.reset': () => null,
    'chat.start': () => null,
    'chat.getMode': () => 'auto-accept',
    'chat.getModel': () => 'opus',
    'chat.getModels': () => [],
    'chat.getEffort': () => null,
    'chat.getAutoEligibility': () => ({ eligible: false, optedIn: false }),
    'chat.setMode': (input) => ({ chatMode: input.chatMode }),
    'chat.setModel': (input) => ({ chatModel: input.chatModel }),
    'chat.setEffort': (input) => ({ chatEffort: input.chatEffort }),
    'chat.listSkills': () => [],
    'chat.listCommands': () => [],
    'chat.listAgents': () => [],
    'chat.getCliSnapshot': () => null,
    'chat.getCliCommandDetails': () => null,
    'chat.getAutocompleteUsage': () => ({}),
    'chat.bumpAutocompleteUsage': () => null,
    'chat.queue.list': () => [],
    'chat.queue.push': () => null,
    'chat.queue.remove': () => null,
    'chat.queue.clear': () => null,
    'chat.stopCommandTask': () => true,
    'chat.commandTaskOutput': () => ({ state: 'gone' })
  }
  const procedures: NonNullable<TrpcTestBackend['procedures']> = {}
  for (const path of Object.keys(handlers)) {
    procedures[path] = (input) => {
      calls.push({ path, input })
      return handlers[path](input)
    }
  }
  const subscriptions: NonNullable<TrpcTestBackend['subscriptions']> = {}
  for (const path of [
    'chat.onEvent',
    'chat.onExit',
    'chat.onQueueChanged',
    'chat.onQueueDrained'
  ]) {
    subscriptions[path] = (input, emit) => {
      ;(subscribed[path] ??= []).push(input)
      const set = live.get(path) ?? new Set()
      live.set(path, set)
      const entry = { emit, input, restart: () => undefined }
      set.add(entry)
      return () => {
        set.delete(entry)
      }
    }
  }
  return {
    backend: { procedures, subscriptions },
    calls,
    subscribed,
    on: (path, handler) => {
      handlers[path] = handler
      if (!procedures[path]) {
        procedures[path] = (input) => {
          calls.push({ path, input })
          return handlers[path](input)
        }
      }
    },
    emit: (path, data) => {
      for (const s of live.get(path) ?? []) s.emit(data)
    },
    restart: () => undefined,
    callsTo: (path) => calls.filter((c) => c.path === path).map((c) => c.input)
  }
}
