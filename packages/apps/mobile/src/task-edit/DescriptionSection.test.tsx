import { act, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { Alert, type AlertButton } from 'react-native'
import { pickUploads } from '../artifacts/pick-uploads'
import { uploadArtifact } from '../artifacts/upload'
import type { TaskRow } from '../hub-board'
import { createFakeHubs, homeHub, projectOf, taskOf, workHub } from '../hubs/testing'
import { DescriptionSection } from './DescriptionSection'
import { type Answer, serveTaskHub, writes } from './testing'

const mockHubs = createFakeHubs()
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
    mockHubs.HubScope(props)
}))
const mockRouter = { push: jest.fn() }
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }))
jest.mock('../artifacts/pick-uploads', () => ({ pickUploads: jest.fn() }))
jest.mock('../artifacts/upload', () => ({ uploadArtifact: jest.fn() }))
jest.mock('../hub-sessions', () => {
  const { hubEntryOf } = jest.requireActual('../hub-session')
  const sessions = [
    { entry: hubEntryOf('home.example'), token: 'h' },
    { entry: hubEntryOf('work.example:8788'), token: 'w' }
  ]
  return { useHubSessions: () => ({ sessions }) }
})

/** Desktop's markdown: artifact links, a task list, code, a table. */
const DESKTOP = [
  'See [spec.md](artifact:a1).',
  '',
  '- [x] done',
  '- [ ] open',
  '',
  '```sh',
  'echo  hi',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  ''
].join('\n')

const rowWith = (
  description: string | null,
  format: 'markdown' | 'html' = 'markdown'
): TaskRow => ({
  key: `${workHub.id}\nt1`,
  hubId: workHub.id,
  hubLabel: workHub.label,
  task: taskOf('t1', { description, description_format: format }),
  project: projectOf('p')
})

async function show(row: TaskRow, answers: Record<string, Answer> = {}) {
  const work = serveTaskHub(mockHubs, workHub.id, answers)
  const home = serveTaskHub(mockHubs, homeHub.id)
  const view = await render(<DescriptionSection row={row} />)
  return {
    work,
    home,
    rerender: (next: TaskRow) => view.rerender(<DescriptionSection row={next} />)
  }
}

const user = () => userEvent.setup()
const editor = () => screen.getByTestId('description-input')

function answerAlert(label: string) {
  return jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons?: AlertButton[]) => {
    buttons?.find((b) => b.text === label)?.onPress?.()
  })
}

beforeEach(() => {
  jest.restoreAllMocks()
  mockRouter.push.mockClear()
  jest.mocked(pickUploads).mockReset()
  jest.mocked(uploadArtifact).mockReset()
})

describe('DescriptionSection', () => {
  it('renders the markdown: task lists, code, tables', async () => {
    await show(rowWith(DESKTOP))
    expect(screen.getByText('spec.md')).toBeOnTheScreen()
    expect(screen.getByText('☑')).toBeOnTheScreen()
    expect(screen.getByText('☐')).toBeOnTheScreen()
    expect(screen.getByText('echo  hi')).toBeOnTheScreen()
  })

  it("an artifact link opens the artifact viewer on the task's hub", async () => {
    await show(rowWith(DESKTOP))
    await user().press(screen.getByText('spec.md'))
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/artifacts/${encodeURIComponent(workHub.label)}/t1/a1`
    )
  })

  it('edits the raw markdown, exactly as desktop wrote it', async () => {
    await show(rowWith(DESKTOP))
    await user().press(screen.getByText('Edit'))
    expect(editor().props.value).toBe(DESKTOP)
  })

  it('Done without a change writes nothing', async () => {
    const { work } = await show(rowWith(DESKTOP))
    await user().press(screen.getByText('Edit'))
    await user().press(screen.getByText('Done'))
    await waitFor(() => expect(screen.queryByTestId('description-input')).toBeNull())
    expect(writes(work)).toEqual([])
  })

  it('a legacy HTML description opens as markdown and stays HTML unless changed', async () => {
    const { work } = await show(rowWith('<p>Hello <strong>you</strong></p>', 'html'))
    expect(screen.getByText('you')).toBeOnTheScreen()
    await user().press(screen.getByText('Edit'))
    expect(editor().props.value).toBe('Hello **you**')
    await user().press(screen.getByText('Done'))
    expect(writes(work)).toEqual([])
  })

  it('saves the whole text only on Done, to the owning hub', async () => {
    const { work, home } = await show(rowWith(DESKTOP), { 'task.get': () => rowWith(DESKTOP).task })
    await user().press(screen.getByText('Edit'))
    await user().type(editor(), 'More.')
    expect(writes(work)).toEqual([])
    await user().press(screen.getByText('Done'))
    await waitFor(() =>
      expect(writes(work)).toEqual([
        { path: 'task.update', input: { id: 't1', description: `${DESKTOP}More.` } }
      ])
    )
    expect(writes(home)).toEqual([])
  })

  it('Cancel with changes asks, then drops them', async () => {
    const { work } = await show(rowWith(DESKTOP))
    await user().press(screen.getByText('Edit'))
    await user().type(editor(), 'x')
    answerAlert('Discard')
    await user().press(screen.getByText('Cancel'))
    await waitFor(() => expect(screen.queryByTestId('description-input')).toBeNull())
    expect(writes(work)).toEqual([])
  })

  it('says when the hub’s description changed meanwhile, and does not overwrite it silently', async () => {
    const { work, rerender } = await show(rowWith('Old'))
    await user().press(screen.getByText('Edit'))
    await user().type(editor(), ' mine')
    await rerender(rowWith('Theirs'))
    expect(screen.getByText(/changed on the hub while you were editing/)).toBeOnTheScreen()
    const alert = answerAlert('Keep editing')
    await user().press(screen.getByText('Done'))
    expect(alert).toHaveBeenCalled()
    expect(writes(work)).toEqual([])
    answerAlert('Overwrite')
    await user().press(screen.getByText('Done'))
    await waitFor(() =>
      expect(writes(work)).toEqual([
        { path: 'task.update', input: { id: 't1', description: 'Old mine' } }
      ])
    )
  })

  it('“Use theirs” replaces the text with the hub’s', async () => {
    const { rerender } = await show(rowWith('Old'))
    await user().press(screen.getByText('Edit'))
    await user().type(editor(), ' mine')
    await rerender(rowWith('Theirs'))
    await user().press(screen.getByText('Use theirs'))
    expect(editor().props.value).toBe('Theirs')
  })

  it('checks the hub at Done: a change the board has not delivered yet is caught too', async () => {
    const { work } = await show(rowWith('Old'), { 'task.get': () => rowWith('Newer').task })
    await user().press(screen.getByText('Edit'))
    await user().type(editor(), '!')
    const alert = answerAlert('Keep editing')
    await user().press(screen.getByText('Done'))
    await waitFor(() => expect(alert).toHaveBeenCalled())
    expect(writes(work)).toEqual([])
    expect(screen.getByText(/changed on the hub while you were editing/)).toBeOnTheScreen()
  })

  it('attaches a photo: uploads it to the task on its hub and links it at the cursor', async () => {
    jest.mocked(pickUploads).mockResolvedValue([{ uri: 'file:///tmp/a.jpg', name: 'a.jpg' }])
    jest.mocked(uploadArtifact).mockResolvedValue({ id: 'art9', title: 'a.jpg' } as never)
    const { work } = await show(rowWith('Before after'), {
      'task.get': () => rowWith('Before after').task
    })
    await user().press(screen.getByText('Edit'))
    await act(() =>
      editor().props.onSelectionChange({ nativeEvent: { selection: { start: 7, end: 7 } } })
    )
    await user().press(screen.getByText('Attach'))
    await user().press(screen.getByText('Photo library'))
    await waitFor(() => expect(editor().props.value).toBe('Before [a.jpg](artifact:art9)after'))
    expect(pickUploads).toHaveBeenCalledWith('photos')
    expect(uploadArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: workHub.id, token: 'w' }),
      expect.objectContaining({ taskId: 't1', file: { uri: 'file:///tmp/a.jpg', name: 'a.jpg' } })
    )
    // Uploaded, linked — but saved only on Done.
    expect(writes(work)).toEqual([])
    await user().press(screen.getByText('Done'))
    await waitFor(() =>
      expect(writes(work)).toEqual([
        {
          path: 'task.update',
          input: { id: 't1', description: 'Before [a.jpg](artifact:art9)after' }
        }
      ])
    )
  })

  it('a failed upload says why and changes nothing', async () => {
    jest.mocked(pickUploads).mockResolvedValue([{ uri: 'file:///tmp/a.jpg', name: 'a.jpg' }])
    jest.mocked(uploadArtifact).mockRejectedValue(new Error('Hub unreachable'))
    await show(rowWith('Text'))
    await user().press(screen.getByText('Edit'))
    await user().press(screen.getByText('Attach'))
    await user().press(screen.getByText('Files'))
    expect(await screen.findByText("Couldn't attach a.jpg: Hub unreachable")).toBeOnTheScreen()
    expect(editor().props.value).toBe('Text')
  })
})
