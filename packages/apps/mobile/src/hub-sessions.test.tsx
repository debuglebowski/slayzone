import { act, renderHook, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
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

function setup(store: HubSessionStore) {
  const themeCache = { forget: jest.fn() }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HubSessionsProvider store={store} themeCache={themeCache}>
      {children}
    </HubSessionsProvider>
  )
  return { themeCache, wrapper }
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
})
