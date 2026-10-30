/**
 * `slayzone://auth/callback` opened OUTSIDE a sign-in (a stray or forged link): the app
 * goes where it would anyway — home signed in, sign-in signed out — and uses nothing in
 * the link. (Inside a sign-in, iOS's auth session takes the URL itself.)
 */
import { renderRouter, screen } from 'expo-router/testing-library'
import type { ReactNode } from 'react'
import type { HubFeed } from '../hub-board'
import type { HubSession } from '../hub-session'

const mockSessions: { kept: HubSession[]; saved: HubSession[] } = { kept: [], saved: [] }

jest.mock('../hub-session', () => {
  const actual = jest.requireActual('../hub-session')
  return {
    ...actual,
    hubSessions: {
      restore: async () => mockSessions.kept,
      save: async (s: HubSession) => void mockSessions.saved.push(s),
      forget: async () => undefined
    }
  }
})
jest.mock('../hub-connections', () => ({
  HubConnections: ({ children }: { children: ReactNode }) => children,
  useHubFeeds: () => ({ feeds: [] as HubFeed[], retry: () => undefined, clientFor: () => null })
}))
jest.mock('../hub-theme', () => ({
  HubThemeProvider: ({ children }: { children: ReactNode }) => children
}))
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: ({ children }: { children: ReactNode }) => children
}))

const { hubEntryOf } = jest.requireActual('../hub-session') as typeof import('../hub-session')

/** Expo Router's first render of the whole app can pass 1 s when the suite runs in parallel. */
const SLOW = { timeout: 5_000 }

const LINK = `/auth/callback?code=${'c'.repeat(43)}&state=forged`

beforeEach(() => {
  mockSessions.kept = []
  mockSessions.saved = []
  global.fetch = jest.fn(async () => {
    throw new Error('no request expected')
  }) as unknown as typeof fetch
})

describe('a stray slayzone://auth/callback link', () => {
  it('signed out: the sign-in screen, nothing exchanged or kept', async () => {
    await renderRouter('src/app', { initialUrl: LINK })
    expect(await screen.findByText('Sign in to a hub', {}, SLOW)).toBeOnTheScreen()
    expect(screen).toHavePathname('/sign-in')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockSessions.saved).toEqual([])
  })

  it('signed in: home, nothing exchanged or kept', async () => {
    mockSessions.kept = [{ entry: hubEntryOf('home.example'), token: 't' }]
    await renderRouter('src/app', { initialUrl: LINK })
    expect(await screen.findByText('Hubs', {}, SLOW)).toBeOnTheScreen()
    expect(screen).toHavePathname('/')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockSessions.saved).toEqual([])
  })
})
