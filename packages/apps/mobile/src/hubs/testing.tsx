/**
 * Test-only helpers for the workspace screens' jest suites (never imported by app
 * code; excluded from the app's tsconfig like `../testing.tsx`).
 *
 * - Fixtures: a hub's feed and board in ONE place, so a field the feed grows (phase 1's
 *   `agents`) is added here once.
 * - `createFakeHubs`: several hubs at once, each with its own in-memory tRPC backend
 *   (`trpcTest`), behind a stand-in for `HubScope`. A test mocks
 *   `@slayzone/transport/client`'s `HubScope` with `mockHubs.HubScope` (a `mock`-named
 *   variable: jest allows it in a hoisted factory), so a component that scopes itself to
 *   the hub owning its row talks to exactly that hub's backend — and a write that went
 *   to the wrong hub shows up in that hub's calls.
 * - `mutatingTrpcTest`: `trpcTest` for components that write (`useMutation`). A finished
 *   mutation arms its own collection timer (gcTime, 5 minutes) and jest does not exit
 *   while it is pending; `gcTime: Infinity` arms none (same reason as `../testing.tsx`).
 */
import type { HubEntry } from '@slayzone/platform/hub-registry'
import type { TrpcTest, TrpcTestBackend } from '@slayzone/transport/testing'
import type { ReactNode } from 'react'
import { NO_AGENT_SESSIONS } from '../agents/hub-agents'
import type { BoardData, BoardProject, BoardTask, HubFeed } from '../hub-board'
import { hubEntryOf } from '../hub-session'
import { trpcTest } from '../testing'

export const homeHub: HubEntry = hubEntryOf('home.example')
export const workHub: HubEntry = hubEntryOf('work.example:8788')

export function projectOf(id: string, fields: Partial<BoardProject> = {}): BoardProject {
  return {
    id,
    name: id,
    color: '',
    placements: [],
    default_computer_id: null,
    resolved_computer_id: null,
    ...fields
  } as BoardProject
}

export function taskOf(id: string, fields: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    title: id,
    status: 'todo',
    priority: 3,
    project_id: 'p',
    parent_id: null,
    computer_id: null,
    description: null,
    ...fields
  } as BoardTask
}

export function boardOf({
  projects = [],
  tasks = []
}: {
  projects?: BoardProject[]
  tasks?: BoardTask[]
}): BoardData {
  return { tasks, projects, tags: [], taskTags: {}, blockedTaskIds: [] } as BoardData
}

/** A connected hub that delivered `board` (undefined = still loading). */
export function feedOf(
  hub: HubEntry,
  board: BoardData | undefined,
  fields: Partial<HubFeed> = {}
): HubFeed {
  return {
    hub,
    connection: { status: 'open', error: null },
    stalled: false,
    board: { data: board, pending: board === undefined, error: null, refreshing: false },
    agents: NO_AGENT_SESSIONS,
    ...fields
  }
}

export function mutatingTrpcTest(backend: TrpcTestBackend): TrpcTest {
  const test = trpcTest(backend)
  const defaults = test.queryClient.getDefaultOptions()
  test.queryClient.setDefaultOptions({
    ...defaults,
    mutations: { ...defaults.mutations, gcTime: Number.POSITIVE_INFINITY }
  })
  return test
}

export interface FakeHubs {
  /** Give a hub a backend (replacing an earlier one); returns its test client. */
  serve(hubId: string, backend: TrpcTestBackend): TrpcTest
  /** Stand-in for `HubScope`: the hub's backend, else `fallback`. */
  HubScope(props: { hubId: string; fallback?: ReactNode; children: ReactNode }): ReactNode
}

export function createFakeHubs(): FakeHubs {
  const hubs = new Map<string, TrpcTest>()
  return {
    serve(hubId, backend) {
      const test = mutatingTrpcTest(backend)
      hubs.set(hubId, test)
      return test
    },
    HubScope({ hubId, fallback = null, children }) {
      const test = hubs.get(hubId)
      if (!test) return fallback
      const Wrapper = test.wrapper
      return <Wrapper>{children}</Wrapper>
    }
  }
}
