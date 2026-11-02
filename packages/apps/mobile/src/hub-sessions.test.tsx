import { act, renderHook, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { DEMO_HUB_ENTRY, type DemoHub } from './demo/demo-hub'
import { type HubSession, type HubSessionStore, hubEntryOf } from './hub-session'
import { HubSessionsProvider, useHubSessions } from './hub-sessions'

const home: HubSession = { entry: hubEntryOf('home.example'), token: 't-home' }
const work: HubSession = { entry: hubEntryOf('work.example'), token: 't-work' }

function fakeStore(kept: HubSession[]): HubSessionStore {
  return {
    restore: jest.fn(async () => kept),
    save: jest.fn(async () => undefined),
    forget: jest.fn(async () => undefined)
  }
}

/** A demo hub stand-in: its session (in process) and whether it was closed. */
function fakeDemo(): DemoHub & { disposed: jest.Mock } {
  const disposed = jest.fn()
  return {
    session: {
      entry: DEMO_HUB_ENTRY,
      token: 'demo',
      inProcess: {
        link: () => () => undefined as never,
        http: async () => ({ status: 404, body: '' })
      }
    },
    backend: {},
    dispose: disposed,
    disposed
  }
}

function setup(store: HubSessionStore) {
  const themeCache = { forget: jest.fn() }
  const artifactFiles = { forget: jest.fn() }
  const demos: Array<ReturnType<typeof fakeDemo>> = []
  const openDemo = () => {
    const demo = fakeDemo()
    demos.push(demo)
    return demo
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HubSessionsProvider
      store={store}
      themeCache={themeCache}
      artifactFiles={artifactFiles}
      openDemo={openDemo}
    >
      {children}
    </HubSessionsProvider>
  )
  return { themeCache, artifactFiles, demos, wrapper }
}

describe('HubSessionsProvider', () => {
  it('is undefined while the keychain is read, then the kept sessions', async () => {
    const { wrapper } = setup(fakeStore([home, work]))
    const { result } = await renderHook(() => useHubSessions(), { wrapper })
    await waitFor(() => expect(result.current.sessions).toEqual([home, work]))
  })

  it('reads an unreadable keychain as signed out', async () => {
    const store = fakeStore([])
    store.restore = jest.fn(async () => {
      throw new Error('keychain locked')
    })
    const { wrapper } = setup(store)
    const { result } = await renderHook(() => useHubSessions(), { wrapper })
    await waitFor(() => expect(result.current.sessions).toEqual([]))
  })

  it('adds a signed-in hub last, and a hub signed in again in its place', async () => {
    const { wrapper } = setup(fakeStore([home]))
    const { result } = await renderHook(() => useHubSessions(), { wrapper })
    await waitFor(() => expect(result.current.sessions).toEqual([home]))

    await act(async () => result.current.signedIn(work))
    const renewed = { ...home, token: 't-new' }
    await act(async () => result.current.signedIn(renewed))
    expect(result.current.sessions).toEqual([renewed, work])
  })

  it('signs out of one hub: its bearer and its kept theme are forgotten', async () => {
    const store = fakeStore([home, work])
    const { wrapper, themeCache } = setup(store)
    const { result } = await renderHook(() => useHubSessions(), { wrapper })
    await waitFor(() => expect(result.current.sessions).toHaveLength(2))

    await act(async () => result.current.signOut(home.entry.id))
    expect(result.current.sessions).toEqual([work])
    expect(store.forget).toHaveBeenCalledWith(home.entry.id)
    expect(themeCache.forget).toHaveBeenCalledWith(home.entry.id)
  })

  describe('the demo', () => {
    it('opens on the demo hub alone, never kept; closing it brings back the hubs kept before', async () => {
      const store = fakeStore([home])
      const { wrapper, demos } = setup(store)
      const { result } = await renderHook(() => useHubSessions(), { wrapper })
      await waitFor(() => expect(result.current.sessions).toEqual([home]))

      await act(async () => result.current.enterDemo())
      expect(result.current.demo).toBe(true)
      expect(result.current.sessions).toEqual([demos[0].session])

      await act(async () => result.current.exitDemo())
      expect(result.current.demo).toBe(false)
      expect(result.current.sessions).toEqual([home])
      expect(demos[0].disposed).toHaveBeenCalled()
      expect(store.save).not.toHaveBeenCalled()
      expect(store.forget).not.toHaveBeenCalled()
    })

    it('signing out of the demo hub closes the demo; its files go, the keychain and kept themes are untouched', async () => {
      const store = fakeStore([])
      const { wrapper, themeCache, artifactFiles } = setup(store)
      const { result } = await renderHook(() => useHubSessions(), { wrapper })
      await waitFor(() => expect(result.current.sessions).toEqual([]))

      await act(async () => result.current.enterDemo())
      await act(async () => result.current.signOut(DEMO_HUB_ENTRY.id))
      expect(result.current.demo).toBe(false)
      expect(result.current.sessions).toEqual([])
      expect(artifactFiles.forget).toHaveBeenCalledWith(DEMO_HUB_ENTRY.id)
      expect(store.forget).not.toHaveBeenCalled()
      expect(themeCache.forget).not.toHaveBeenCalled()
    })

    it('each demo is a new hub: what was written in one is gone in the next', async () => {
      const { wrapper, demos } = setup(fakeStore([]))
      const { result } = await renderHook(() => useHubSessions(), { wrapper })
      await waitFor(() => expect(result.current.sessions).toEqual([]))
      await act(async () => result.current.enterDemo())
      await act(async () => result.current.exitDemo())
      await act(async () => result.current.enterDemo())
      expect(demos).toHaveLength(2)
      expect(result.current.sessions).toEqual([demos[1].session])
    })

    it('a real sign-in from inside the demo (Hubs → Add a hub) closes it', async () => {
      const { wrapper, demos } = setup(fakeStore([]))
      const { result } = await renderHook(() => useHubSessions(), { wrapper })
      await waitFor(() => expect(result.current.sessions).toEqual([]))
      await act(async () => result.current.enterDemo())
      await act(async () => result.current.signedIn(work))
      expect(result.current.demo).toBe(false)
      expect(result.current.sessions).toEqual([work])
      expect(demos[0].disposed).toHaveBeenCalled()
    })
  })
})
