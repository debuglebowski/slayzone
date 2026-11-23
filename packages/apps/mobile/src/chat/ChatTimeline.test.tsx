/**
 * The timeline as a list: kept at the newest row while the user is there (new rows and
 * streaming text stay in view), kept where it is when scrolled up, with a "jump to
 * latest" pill; a message's text copied or shared from a long press; what was opened
 * (a tool card) stays open when the list recycles its row.
 */
import { initialState, type TimelineItem } from '@slayzone/terminal/reducer'
import { act, fireEvent, render, screen, userEvent, within } from '@testing-library/react-native'
import * as Clipboard from 'expo-clipboard'
import { FlatList, Share } from 'react-native'
import { trpcTest } from '../testing'
import { ChatTimeline } from './ChatTimeline'
import { ChatViewContext, type ChatViewValue } from './ChatViewContext'
import { fakeHub } from './fake-hub'

const view: ChatViewValue = {
  tabId: 't1',
  retryMessage: jest.fn(),
  prompts: [],
  restartAgent: jest.fn(),
  takeOver: jest.fn()
}

const answer = (i: number, text = `Answer ${i}`): TimelineItem => ({
  kind: 'text',
  role: 'assistant',
  messageId: `m${i}`,
  text,
  timestamp: i
})

const stateOf = (items: TimelineItem[]) => ({ ...initialState(), timeline: items }) as never

async function show(items: TimelineItem[]) {
  const { wrapper } = trpcTest(fakeHub({ tabId: 't1', taskId: 't1' }).backend)
  return render(
    <ChatViewContext.Provider value={view}>
      <ChatTimeline state={stateOf(items)} hydrating={false} working={false} emptyText="Empty" />
    </ChatViewContext.Provider>,
    { wrapper }
  )
}

const scrollTo = (y: number) =>
  fireEvent.scroll(screen.getByTestId('chat-timeline'), {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { width: 390, height: 4000 },
      layoutMeasurement: { width: 390, height: 600 }
    }
  })

afterEach(() => jest.restoreAllMocks())

describe('ChatTimeline', () => {
  it('follows the newest row while at it, and holds its place when scrolled up', async () => {
    await show([answer(1)])
    const mvcp = screen.getByTestId('chat-timeline').props.maintainVisibleContentPosition
    expect(mvcp.minIndexForVisible).toBe(1)
    // At (or near) the newest row a change scrolls back to it: new rows, a growing answer.
    expect(mvcp.autoscrollToTopThreshold).toBeGreaterThan(0)
  })

  it('scrolled away from the newest row, a pill jumps back to it', async () => {
    const toOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})
    await show(Array.from({ length: 30 }, (_, i) => answer(i)))
    expect(screen.queryByLabelText('Jump to latest')).toBeNull()
    await act(async () => scrollTo(150))
    expect(screen.queryByLabelText('Jump to latest')).toBeNull()
    await act(async () => scrollTo(900))
    await userEvent.setup().press(screen.getByLabelText('Jump to latest'))
    expect(toOffset).toHaveBeenCalledWith({ offset: 0, animated: true })
    expect(screen.queryByLabelText('Jump to latest')).toBeNull()
  })

  it('a long press on an answer copies its text or only its code, or shares it', async () => {
    const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true)
    const share = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction', activityType: undefined })
    const text = 'Run this:\n\n```sh\npnpm test\n```\n\nThen commit.'
    await show([answer(1, text)])
    const user = userEvent.setup()
    const actions = async () => {
      await user.longPress(screen.getByText('Then commit.'))
      return within(await screen.findByTestId('message-actions'))
    }
    await user.press((await actions()).getByText('Copy code'))
    expect(copy).toHaveBeenLastCalledWith('pnpm test')
    await user.press((await actions()).getByText('Copy text'))
    expect(copy).toHaveBeenLastCalledWith(text)
    await user.press((await actions()).getByText('Share…'))
    expect(share).toHaveBeenLastCalledWith({ message: text })
  })

  it('opens message actions from table cells without blocking the scroll view', async () => {
    await show([answer(1, '| Name | Value |\n| --- | --- |\n| Limit | 123 |')])
    let parent = screen.getByTestId('markdown-table-scroll').parent
    while (parent && parent.props.testID !== 'chat-timeline') {
      expect(parent.props.onResponderGrant).toBeUndefined()
      parent = parent.parent
    }
    await userEvent.setup().longPress(screen.getByText('Limit'))
    expect(
      within(await screen.findByTestId('message-actions')).getByText('Copy text')
    ).toBeOnTheScreen()
  })

  it('an answer without code offers no "code" action', async () => {
    await show([answer(1, 'Plain words.')])
    await userEvent.setup().longPress(screen.getByText('Plain words.'))
    const sheet = within(await screen.findByTestId('message-actions'))
    expect(sheet.getByText('Copy text')).toBeOnTheScreen()
    expect(sheet.queryByText('Copy code')).toBeNull()
  })

  it('an opened tool card stays open when its row is drawn again', async () => {
    const tool: TimelineItem = {
      kind: 'tool',
      invocation: {
        id: 'tu1',
        name: 'Bash',
        input: { command: 'ls' },
        status: 'done',
        result: { content: 'a.txt' }
      },
      timestamp: 2
    } as never
    const view1 = await show([tool])
    await userEvent.setup().press(screen.getByRole('button', { name: /Bash/ }))
    expect(screen.getByRole('button', { name: /Bash/ })).toBeExpanded()
    // The list unmounts an off-screen row and mounts it again later.
    await view1.rerender(
      <ChatViewContext.Provider value={view}>
        <ChatTimeline state={stateOf([])} hydrating={false} working={false} emptyText="Empty" />
      </ChatViewContext.Provider>
    )
    await view1.rerender(
      <ChatViewContext.Provider value={view}>
        <ChatTimeline state={stateOf([tool])} hydrating={false} working={false} emptyText="Empty" />
      </ChatViewContext.Provider>
    )
    expect(screen.getByRole('button', { name: /Bash/ })).toBeExpanded()
  })

  it('a long tool output shows its first lines; Show all opens all of it, selectable', async () => {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const tool = {
      kind: 'tool',
      invocation: {
        id: 'tu2',
        name: 'Bash',
        input: { command: 'cat a.txt' },
        status: 'done',
        result: { rawContent: output }
      },
      timestamp: 3
    } as never
    await show([tool])
    const user = userEvent.setup()
    await user.press(screen.getByRole('button', { name: /Bash/ }))
    // `$ cat a.txt`, then the first 11 lines of output.
    expect(screen.getByText(/line 11$/)).toBeOnTheScreen()
    expect(screen.queryByText(/line 12/)).toBeNull()
    await user.press(screen.getByLabelText('Show all 41 lines'))
    const viewer = within(screen.getByTestId('text-viewer'))
    expect(viewer.getByText(/line 40/)).toBeOnTheScreen()
    expect(viewer.getByText(/line 40/).props.selectable).toBe(true)
  })
})

describe('reconnecting', () => {
  it('says it is reconnecting instead of working: the turn state is the last known one', async () => {
    const { wrapper } = trpcTest(fakeHub({ tabId: 't1', taskId: 't1' }).backend)
    const view1 = await render(
      <ChatViewContext.Provider value={view}>
        <ChatTimeline
          state={stateOf([answer(0, 'hi')])}
          hydrating={false}
          working
          emptyText="Empty"
        />
      </ChatViewContext.Provider>,
      { wrapper }
    )
    expect(await screen.findByText('Working…')).toBeTruthy()
    await view1.rerender(
      <ChatViewContext.Provider value={view}>
        <ChatTimeline
          state={stateOf([answer(0, 'hi')])}
          hydrating={false}
          working
          reconnecting
          emptyText="Empty"
        />
      </ChatViewContext.Provider>
    )
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
    expect(screen.queryByText('Working…')).toBeNull()
  })
})
