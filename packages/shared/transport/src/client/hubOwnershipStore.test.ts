import { beforeEach, describe, expect, it, vi } from 'vitest'

// The client resolvers only need `getHubClient` + `getTrpcClient`; stub them so
// the test never opens a real WS (createWSClient has no WebSocket in node).
const DEFAULT_CLIENT = { __hub: 'default' }
const REMOTE_CLIENT = { __hub: 'remote-a' }
vi.mock('./trpc', () => ({
  getTrpcClient: () => DEFAULT_CLIENT,
  getHubClient: (id: string) => (id === 'remote-a' ? { id, client: REMOTE_CLIENT } : null),
  useTRPCClient: () => DEFAULT_CLIENT
}))

const {
  useHubOwnershipStore,
  getHubIdForProject,
  getHubIdForTask,
  getClientForProject,
  getClientForTask
} = await import('./hubOwnershipStore')

const EMPTY = { hubIdByProject: new Map(), hubIdByTask: new Map(), seededProjects: new Map(), seededTasks: new Map() }

describe('hubOwnershipStore', () => {
  beforeEach(() => {
    useHubOwnershipStore.setState({ ...EMPTY })
  })

  it('setOwnership replaces both maps (the board-recompose path)', () => {
    useHubOwnershipStore
      .getState()
      .setOwnership(new Map([['p-1', 'local']]), new Map([['t-1', 'local']]))
    expect(getHubIdForProject('p-1')).toBe('local')
    expect(getHubIdForTask('t-1')).toBe('local')

    useHubOwnershipStore
      .getState()
      .setOwnership(new Map([['p-2', 'remote-a']]), new Map([['t-2', 'remote-a']]))
    expect(getHubIdForProject('p-1')).toBeUndefined()
    expect(getHubIdForProject('p-2')).toBe('remote-a')
    expect(getHubIdForTask('t-2')).toBe('remote-a')
  })

  it('a noted task survives a recompose that predates its owning hub reload', () => {
    // Create routes to remote-a and seeds the id. The very next recompose only
    // carries the DEFAULT hub's board (the remote reload has not landed yet) —
    // the seed must not be dropped, or the new tab renders under the wrong hub.
    useHubOwnershipStore.getState().noteTaskHub('t-new', 'remote-a')
    expect(getHubIdForTask('t-new')).toBe('remote-a')

    useHubOwnershipStore.getState().setOwnership(new Map([['p-1', 'local']]), new Map([['t-1', 'local']]))
    expect(getHubIdForTask('t-new')).toBe('remote-a')
    expect(getHubIdForTask('t-1')).toBe('local')
  })

  it('a seed retires once the authoritative board covers it', () => {
    useHubOwnershipStore.getState().noteTaskHub('t-new', 'remote-a')
    useHubOwnershipStore.getState().setOwnership(new Map(), new Map([['t-new', 'remote-a']]))
    expect(useHubOwnershipStore.getState().seededTasks.has('t-new')).toBe(false)

    // Retired → a later board that no longer lists it (deleted) drops it too.
    useHubOwnershipStore.getState().setOwnership(new Map(), new Map())
    expect(getHubIdForTask('t-new')).toBeUndefined()
  })

  it('the authoritative board wins over a stale seed for the same id', () => {
    useHubOwnershipStore.getState().noteTaskHub('t-1', 'remote-a')
    useHubOwnershipStore.getState().setOwnership(new Map(), new Map([['t-1', 'local']]))
    expect(getHubIdForTask('t-1')).toBe('local')
  })

  it('noteProjectHub seeds a project the same way', () => {
    useHubOwnershipStore.getState().noteProjectHub('p-new', 'remote-a')
    useHubOwnershipStore.getState().setOwnership(new Map([['p-1', 'local']]), new Map())
    expect(getHubIdForProject('p-new')).toBe('remote-a')
  })

  it('routes an owned entity to its hub client and everything else to the default', () => {
    useHubOwnershipStore
      .getState()
      .setOwnership(new Map([['p-remote', 'remote-a'], ['p-local', 'local']]), new Map([['t-remote', 'remote-a']]))

    expect(getClientForProject('p-remote')).toBe(REMOTE_CLIENT)
    expect(getClientForTask('t-remote')).toBe(REMOTE_CLIENT)
    // Owned by the default hub, unknown, or unnamed → the boot singleton.
    expect(getClientForProject('p-local')).toBe(DEFAULT_CLIENT)
    expect(getClientForProject('p-unknown')).toBe(DEFAULT_CLIENT)
    expect(getClientForProject(undefined)).toBe(DEFAULT_CLIENT)
  })
})
