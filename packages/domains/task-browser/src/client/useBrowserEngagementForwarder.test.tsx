// @vitest-environment jsdom
// Idle-close parity with main: every `engaged` from this device's web views — browser
// tabs AND web panels, whether or not any browser panel is mounted — reaches the hub
// that owns the task, with this client's key (it also decides `slay browser` owner).
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'

type Handler = (payload: { taskId: string }) => void
let engagedHandler: Handler | null = null
vi.mock('./browser-host', () => ({
  BROWSER_CLIENT_KEY: 'this-client',
  getBrowserHost: () => ({}),
  useBrowserHostEvent: (event: string, handler: Handler) => {
    if (event === 'engaged') engagedHandler = handler
  }
}))

const mutateByHub = new Map<string, ReturnType<typeof vi.fn>>()
const clientFor = (hubId: string) => {
  let mutate = mutateByHub.get(hubId)
  if (!mutate) {
    mutate = vi.fn(() => Promise.resolve())
    mutateByHub.set(hubId, mutate)
  }
  return {
    app: {
      browserRelay: {
        engaged: { mutate },
        present: {
          subscribe: (..._a: unknown[]) => {
            presentOn.push(hubId)
            return { unsubscribe: () => presentOff.push(hubId) }
          }
        }
      }
    }
  }
}
const presentOn: string[] = []
const presentOff: string[] = []
vi.mock('@slayzone/transport/client', () => ({
  getHubIdForTask: (taskId: string) => (taskId === 'remote-task' ? 'hub-b' : undefined),
  getClientForHub: (hubId: string | undefined) => clientFor(hubId ?? 'default'),
  useFederationOrNull: () => federation,
  useHubRegistryStore: (sel: (s: { hubs: Array<{ id: string }> }) => unknown) =>
    sel({ hubs: federation ? [{ id: 'local' }, { id: 'hub-b' }] : [] })
}))
let federation: { resolve: (id: string) => { ws: { client: unknown } } } | null = null

const { useBrowserEngagementForwarder } = await import('./useBrowserEngagementForwarder')

afterEach(() => {
  cleanup()
  mutateByHub.clear()
  engagedHandler = null
  presentOn.length = 0
  presentOff.length = 0
  federation = null
})

it('tells every hub this device is a desktop app while mounted (no-desktop error)', () => {
  federation = { resolve: (id) => ({ ws: { client: clientFor(id) } }) }
  const view = renderHook(() => useBrowserEngagementForwarder())
  expect(presentOn.sort()).toEqual(['hub-b', 'local'])
  view.unmount()
  expect(presentOff.sort()).toEqual(['hub-b', 'local'])
})

it('a task window (no federation) is present on its own hub', () => {
  renderHook(() => useBrowserEngagementForwarder())
  expect(presentOn).toEqual(['default'])
})

it('forwards a web-panel engagement with no browser panel mounted', () => {
  renderHook(() => useBrowserEngagementForwarder())
  engagedHandler!({ taskId: 'web-panel-task' })
  expect(mutateByHub.get('default')).toHaveBeenCalledWith({
    taskId: 'web-panel-task',
    clientKey: 'this-client'
  })
})

it('routes to the hub that owns the task', () => {
  renderHook(() => useBrowserEngagementForwarder())
  engagedHandler!({ taskId: 'remote-task' })
  expect(mutateByHub.get('hub-b')).toHaveBeenCalledWith({
    taskId: 'remote-task',
    clientKey: 'this-client'
  })
  expect(mutateByHub.get('default') ?? vi.fn()).not.toHaveBeenCalled()
})
