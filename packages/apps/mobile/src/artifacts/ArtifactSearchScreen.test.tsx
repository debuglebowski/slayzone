import { render, screen, userEvent } from '@testing-library/react-native'
import type { HubFeed } from '../hub-board'
import { type HubSession, hubEntryOf } from '../hub-session'
import { ArtifactSearchScreen } from './ArtifactSearchScreen'
import { fakeFetch } from './testing'

const home: HubSession = { entry: hubEntryOf('home.example'), token: 'h' }
const work: HubSession = { entry: hubEntryOf('work.example'), token: 'w' }

const feedOf = (session: HubSession, taskTitle: string): HubFeed =>
  ({
    hub: session.entry,
    connection: { status: 'open', error: null },
    stalled: false,
    board: {
      data: {
        tasks: [{ id: 't1', title: taskTitle, parent_id: null, project_id: 'p' }],
        projects: []
      },
      pending: false,
      error: null,
      refreshing: false
    }
  }) as unknown as HubFeed

const reportWith = (artifactId: string, title: string, line: number, snippet: string) => ({
  ok: true,
  data: {
    results: [
      {
        artifactId,
        taskId: 't1',
        title,
        matches: [{ type: 'content', line, snippet, contextBefore: null, contextAfter: null }]
      }
    ],
    scannedCount: 3,
    truncated: false,
    skippedLarge: []
  }
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('ArtifactSearchScreen', () => {
  it('searches every hub as you type and merges the results, each with its task and hub', async () => {
    const fetch = fakeFetch(({ url }) => ({
      status: 200,
      body: url.includes('home.')
        ? reportWith('a1', 'plan.md', 4, 'the launch plan')
        : reportWith('b1', 'notes.md', 12, 'plan B')
    }))
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch
    const onOpen = jest.fn()
    await render(
      <ArtifactSearchScreen
        sessions={[home, work]}
        feeds={[feedOf(home, 'Launch'), feedOf(work, 'Offsite')]}
        onOpen={onOpen}
      />
    )
    const user = userEvent.setup()
    await user.type(screen.getByTestId('artifact-search-input'), 'plan')

    await screen.findByTestId('artifact-search-result-a1')
    expect(screen.getByTestId('artifact-search-result-b1')).toBeOnTheScreen()
    expect(screen.getByText('Launch · home.example')).toBeOnTheScreen()
    expect(screen.getByText('Offsite · work.example')).toBeOnTheScreen()
    expect(screen.getByText('the launch plan')).toBeOnTheScreen()
    expect(screen.getByText('12')).toBeOnTheScreen()
    // Typing debounced: one search per hub, for the whole word.
    expect(fetch.calls.map((c) => c.url)).toEqual([
      'https://home.example/api/artifacts/search?q=plan&allTasks=1',
      'https://work.example/api/artifacts/search?q=plan&allTasks=1'
    ])

    await user.press(screen.getByTestId('artifact-search-result-b1'))
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'b1', taskId: 't1', hubLabel: 'work.example' })
    )
  })

  it("sends desktop's options (match case, regex) and shows a hub's failure under the others' results", async () => {
    const fetch = fakeFetch(({ url }) =>
      url.includes('home.')
        ? { status: 400, body: { ok: false, code: 'INVALID_REGEX', error: 'Invalid regex: (' } }
        : { status: 200, body: reportWith('b1', 'notes.md', 1, '(x') }
    )
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch
    await render(<ArtifactSearchScreen sessions={[home, work]} feeds={[]} onOpen={jest.fn()} />)
    const user = userEvent.setup()
    await user.press(screen.getByRole('button', { name: 'Match case' }))
    await user.press(screen.getByRole('button', { name: 'Regular expression' }))
    await user.type(screen.getByTestId('artifact-search-input'), '(')

    await screen.findByTestId('artifact-search-result-b1')
    expect(screen.getByTestId('artifact-search-failed-home.example')).toHaveTextContent(
      'home.example: Invalid regex: ('
    )
    expect(fetch.calls[0].url).toBe(
      'https://home.example/api/artifacts/search?q=(&allTasks=1&regex=1&caseSensitive=1'
    )
  })
})
