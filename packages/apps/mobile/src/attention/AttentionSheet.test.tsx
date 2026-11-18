import type { TerminalState } from '@slayzone/terminal-contracts'
import { EMPTY_TERMINAL_STATE } from '@slayzone/terminal/terminal-state'
import { render, screen, within } from '@testing-library/react-native'
import type { HubFeed } from '../hub-board'
import { boardOf, feedOf, homeHub, projectOf, taskOf } from '../hubs/testing'
import { AttentionSheet } from './AttentionSheet'

jest.mock('../hub-connections', () => ({
  useHubFeeds: () => ({ clientFor: () => ({ task: { update: { mutate: jest.fn() } } }) })
}))

const agents = (byId: Record<string, TerminalState>) => ({
  state: { ...EMPTY_TERMINAL_STATE, byId },
  loaded: true,
  error: null
})

const show = (feeds: HubFeed[]) =>
  render(
    <AttentionSheet
      feeds={feeds}
      visible
      project={null}
      onOpen={() => undefined}
      onClose={() => undefined}
    />
  )

describe('AttentionSheet', () => {
  it('says it is loading — not "No agents" — until the hub’s agents are in', async () => {
    await show([feedOf(homeHub, boardOf({ tasks: [taskOf('a')] }))])
    const sheet = within(screen.getByTestId('attention-sheet'))
    expect(sheet.getByText('Loading agents…')).toBeOnTheScreen()
    expect(sheet.queryByText('No agents')).toBeNull()
  })

  it('says why the agents could not be listed', async () => {
    await show([
      feedOf(homeHub, boardOf({}), {
        agents: { state: EMPTY_TERMINAL_STATE, loaded: false, error: 'socket closed' }
      })
    ])
    expect(
      screen.getByText(`Couldn’t load the agents. ${homeHub.label}: socket closed`)
    ).toBeOnTheScreen()
  })

  it('lists the agents under a header per group', async () => {
    await show([
      feedOf(
        homeHub,
        boardOf({
          projects: [projectOf('p', { name: 'Website' })],
          tasks: [
            taskOf('run', { title: 'Cookie banner' }),
            taskOf('wait', { title: 'Landing', needs_attention: true } as never)
          ]
        }),
        { agents: agents({ 'run:run': 'running', 'wait:wait': 'idle' }) }
      )
    ])
    const sheet = within(screen.getByTestId('attention-sheet'))
    expect(sheet.getByRole('header', { name: 'Ready for review' })).toBeOnTheScreen()
    expect(sheet.getByRole('header', { name: 'Running' })).toBeOnTheScreen()
    expect(sheet.queryByText('No agents')).toBeNull()
  })
})
