import type { HubConnection } from '@slayzone/transport/client'
import { act, render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import type { HubComputer } from './computers/hub-computers'
import type { HubFeed } from './hub-board'
import type { HubSession } from './hub-session'
import { HubsScreen } from './HubsScreen'
import { createFakeHubs, feedOf, homeHub, workHub } from './hubs/testing'

const mockHubs = createFakeHubs()
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
    mockHubs.HubScope(props)
}))
// Who a bearer belongs to (the hub's get-session, over the phone's fetch).
const mockAccounts: Record<string, string> = {}
jest.mock('@slayzone/hub-auth/client', () => ({
  ...jest.requireActual('@slayzone/hub-auth/client'),
  fetchSessionEmail: async (_transport: unknown, _baseUrl: string, token: string) =>
    mockAccounts[token] ?? null
}))

const sessions: HubSession[] = [
  { entry: homeHub, token: 't-home' },
  { entry: workHub, token: 't-work' }
]

const computer = (fields: Partial<HubComputer>): HubComputer =>
  ({
    id: 'mini',
    name: 'mac-mini',
    platform: 'darwin-arm64',
    connected: true,
    usable: true,
    lastSeenAt: 1,
    revokedAt: null,
    machine: { hostId: 'h', name: 'Studio' },
    ...fields
  }) as HubComputer

function setup() {
  mockAccounts['t-home'] = 'me@home.example'
  mockAccounts['t-work'] = 'me@work.example'
  let online = true
  let emitWork: (data: unknown) => void = () => undefined
  mockHubs.serve(homeHub.id, {
    procedures: { 'computers.list': () => [] },
    subscriptions: { 'computers.onStatusChange': () => undefined }
  })
  mockHubs.serve(workHub.id, {
    procedures: {
      'computers.list': () => [computer({ connected: online, usable: online, lastSeenAt: null })]
    },
    subscriptions: {
      'computers.onStatusChange': (_input, push) => {
        emitWork = push
      }
    }
  })
  const handlers = { onAdd: jest.fn(), onSignOut: jest.fn() }
  const feeds: HubFeed[] = [
    feedOf(homeHub, undefined, { connection: { status: 'open', error: null } }),
    feedOf(workHub, undefined, {
      connection: { status: 'connecting', error: new Error('WebSocket closed') } as HubConnection,
      stalled: true
    })
  ]
  return {
    handlers,
    feeds,
    goOffline: async () => {
      online = false
      await act(async () => emitWork({ computerId: 'mini', connected: false }))
    }
  }
}

const hubCard = (hub: typeof homeHub) => within(screen.getByTestId(`hub-${hub.id}`))

describe('HubsScreen', () => {
  it('lists the signed-in hubs with their connection, the first one painting the theme', async () => {
    const { handlers, feeds } = setup()
    await render(<HubsScreen feeds={feeds} sessions={sessions} {...handlers} />)

    expect(hubCard(homeHub).getByText('home.example')).toBeOnTheScreen()
    expect(hubCard(homeHub).getByText('Connected · theme from this hub')).toBeOnTheScreen()
    expect(hubCard(workHub).getByText("Can't reach")).toBeOnTheScreen()
  })

  it('shows who is signed in on each hub', async () => {
    const { handlers, feeds } = setup()
    await render(<HubsScreen feeds={feeds} sessions={sessions} {...handlers} />)
    expect(await screen.findByText('Signed in as me@home.example')).toBeOnTheScreen()
    expect(await hubCard(workHub).findByText('Signed in as me@work.example')).toBeOnTheScreen()
  })

  it("lists each hub's computers with their state, live", async () => {
    const { handlers, feeds, goOffline } = setup()
    await render(<HubsScreen feeds={feeds} sessions={sessions} {...handlers} />)

    const work = within(await screen.findByTestId(`hub-computers-${workHub.id}`))
    expect(await work.findByText('mac-mini')).toBeOnTheScreen()
    expect(work.getByText('darwin-arm64 · Studio')).toBeOnTheScreen()
    expect(work.getByText('Connected')).toBeOnTheScreen()
    expect(await hubCard(homeHub).findByText('No computers — runs locally')).toBeOnTheScreen()

    await goOffline()
    await waitFor(() => expect(work.getByText('Never connected')).toBeOnTheScreen())
  })

  it('signs out of one hub', async () => {
    const { handlers, feeds } = setup()
    await render(<HubsScreen feeds={feeds} sessions={sessions} {...handlers} />)
    await userEvent.setup().press(hubCard(workHub).getByText('Sign out'))
    expect(handlers.onSignOut).toHaveBeenCalledWith(workHub.id)
  })

  it('adds a hub', async () => {
    const { handlers, feeds } = setup()
    await render(<HubsScreen feeds={feeds} sessions={sessions} {...handlers} />)
    await userEvent.setup().press(screen.getByText('Add a hub'))
    expect(handlers.onAdd).toHaveBeenCalled()
  })
})
