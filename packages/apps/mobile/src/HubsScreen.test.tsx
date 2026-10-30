import type { HubConnection } from '@slayzone/transport/client'
import { render, screen, userEvent, within } from '@testing-library/react-native'
import type { HubFeed } from './hub-board'
import { hubEntryOf } from './hub-session'
import { HubsScreen } from './HubsScreen'

const home = hubEntryOf('home.example')
const work = hubEntryOf('work.example:8788')

const feed = (hub: typeof home, connection: HubConnection, stalled = false): HubFeed => ({
  hub,
  connection,
  stalled,
  board: { data: undefined, pending: true, error: null, refreshing: false }
})

function setup() {
  const handlers = { onAdd: jest.fn(), onSignOut: jest.fn(), onBack: jest.fn() }
  const feeds = [
    feed(home, { status: 'open', error: null }),
    feed(work, { status: 'connecting', error: new Error('WebSocket closed') }, true)
  ]
  return { handlers, feeds }
}

describe('HubsScreen', () => {
  it('lists the signed-in hubs with their connection, the first one painting the theme', async () => {
    const { handlers, feeds } = setup()
    await render(<HubsScreen feeds={feeds} {...handlers} />)

    const first = within(screen.getByTestId(`hub-${home.id}`))
    expect(first.getByText('home.example')).toBeOnTheScreen()
    expect(first.getByText('Connected · theme from this hub')).toBeOnTheScreen()
    const second = within(screen.getByTestId(`hub-${work.id}`))
    expect(second.getByText("Can't reach")).toBeOnTheScreen()
  })

  it('signs out of one hub', async () => {
    const { handlers, feeds } = setup()
    await render(<HubsScreen feeds={feeds} {...handlers} />)

    await userEvent
      .setup()
      .press(within(screen.getByTestId(`hub-${work.id}`)).getByText('Sign out'))
    expect(handlers.onSignOut).toHaveBeenCalledWith(work.id)
  })

  it('adds a hub', async () => {
    const { handlers, feeds } = setup()
    await render(<HubsScreen feeds={feeds} {...handlers} />)
    await userEvent.setup().press(screen.getByText('Add a hub'))
    expect(handlers.onAdd).toHaveBeenCalled()
  })
})
