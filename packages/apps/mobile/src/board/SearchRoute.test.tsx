/**
 * The Search tab: one query, every signed-in hub's tasks (from the boards the app holds)
 * above every hub's artifacts (the hubs' artifact search, faked at `fetch`).
 */
import { render, screen, userEvent, within } from '@testing-library/react-native'
import { fakeFetch } from '../artifacts/testing'
import type { HubFeed } from '../hub-board'
import type { HubSession } from '../hub-session'
import { boardOf, feedOf, homeHub, projectOf, taskOf, workHub } from '../hubs/testing'
import { SearchRoute } from './SearchRoute'

const mockRouter = { push: jest.fn() }
const mockState: { feeds: HubFeed[]; sessions: HubSession[] } = { feeds: [], sessions: [] }
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }))
jest.mock('../hub-connections', () => ({
  useHubFeeds: () => ({ feeds: mockState.feeds, retry: () => undefined, clientFor: () => null })
}))
jest.mock('../hub-sessions', () => ({ useHubSessions: () => ({ sessions: mockState.sessions }) }))

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  mockState.sessions = [
    { entry: homeHub, token: 'h' },
    { entry: workHub, token: 'w' }
  ]
  mockState.feeds = [
    feedOf(
      homeHub,
      boardOf({
        projects: [projectOf('p', { name: 'Site' })],
        tasks: [taskOf('t1', { title: 'Launch plan', description: 'Ship it' })]
      })
    ),
    feedOf(
      workHub,
      boardOf({
        projects: [projectOf('p', { name: 'API' })],
        tasks: [
          taskOf('t1', { title: 'Docs', description: 'Write the launch notes' }),
          taskOf('t2', { title: 'Unrelated' })
        ]
      })
    )
  ]
  const report = {
    ok: true,
    data: {
      results: [
        {
          artifactId: 'a1',
          taskId: 't1',
          title: 'launch.md',
          matches: [{ type: 'title', line: null, snippet: 'launch.md' }]
        }
      ],
      scannedCount: 1,
      truncated: false,
      skippedLarge: []
    }
  }
  globalThis.fetch = fakeFetch(({ url }) => ({
    status: 200,
    body: url.includes('home.') ? report : { ...report, data: { ...report.data, results: [] } }
  })) as unknown as typeof globalThis.fetch
})

describe('Search tab', () => {
  it("finds every hub's tasks (titles and descriptions) above the artifacts", async () => {
    await render(<SearchRoute />)
    await userEvent.setup().type(screen.getByTestId('artifact-search-input'), 'launch')
    const tasks = within(screen.getByTestId('task-search-results'))
    expect(tasks.getByText('Launch plan')).toBeOnTheScreen()
    expect(tasks.getByText('Docs')).toBeOnTheScreen()
    expect(tasks.getByText('Write the launch notes')).toBeOnTheScreen()
    expect(tasks.queryByText('Unrelated')).toBeNull()
    expect(await screen.findByTestId('artifact-search-result-a1')).toBeOnTheScreen()
  })

  it('opens a task in its own hub (both hubs have a task t1)', async () => {
    await render(<SearchRoute />)
    const user = userEvent.setup()
    await user.type(screen.getByTestId('artifact-search-input'), 'docs')
    await user.press(screen.getByTestId(`task-search-result-${workHub.label}-t1`))
    expect(mockRouter.push).toHaveBeenCalledWith(`/task/${encodeURIComponent(workHub.label)}/t1`)
  })
})
