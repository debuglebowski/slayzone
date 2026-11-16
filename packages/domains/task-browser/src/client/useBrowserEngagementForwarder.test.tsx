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
  return { app: { browserRelay: { engaged: { mutate } } } }
}
vi.mock('@slayzone/transport/client', () => ({
  getHubIdForTask: (taskId: string) => (taskId === 'remote-task' ? 'hub-b' : undefined),
  getClientForHub: (hubId: string | undefined) => clientFor(hubId ?? 'default')
}))

const { useBrowserEngagementForwarder } = await import('./useBrowserEngagementForwarder')

afterEach(() => {
  cleanup()
  mutateByHub.clear()
  engagedHandler = null
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
  expect(mutateByHub.get('default')).toBeUndefined()
})
