import { act, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import * as Clipboard from 'expo-clipboard'
import { Keyboard, Share, StyleSheet } from 'react-native'
import { openWebLink } from '../chat/Markdown'
import * as keyboardOverlap from '../chat/use-keyboard'
import { trpcTest } from '../testing'
import { TerminalView, type TerminalViewHandle } from './TerminalView'

/** What the web view's terminal was sent, and the props it got. */
const mockDom = {
  ops: [] as string[],
  props: null as null | {
    textSize: 'readable' | 'fit'
    onModes: (applicationCursorKeys: boolean) => Promise<void>
    onInteract: () => Promise<void>
    onInput: (data: string) => Promise<void>
    onOpenLink: (url: string) => Promise<void>
    onTextSize: (size: 'readable' | 'fit') => Promise<void>
    onText: (text: string) => Promise<void>
  }
}

// Opening a link is the chat's rule (web links only); here: that a tap reaches it.
jest.mock('../chat/Markdown', () => ({ openWebLink: jest.fn() }))

/** The device's kept terminal preferences (a file on the phone). */
const mockPrefs = { text: null as string | null }
jest.mock('./terminal-prefs-file', () => {
  const { createTerminalPrefs } = jest.requireActual('./terminal-prefs')
  return {
    terminalPrefsFile: createTerminalPrefs({
      read: () => mockPrefs.text,
      write: (text: string) => {
        mockPrefs.text = text
      }
    })
  }
})

// The web view (a DOM component) cannot run in Node: a stand-in with its handle.
jest.mock('./TerminalDom', () => {
  const { useEffect, useImperativeHandle, useState } = jest.requireActual('react')
  function FakeTerminalDom(
    props: NonNullable<typeof mockDom.props> & {
      ref: unknown
      onReady: () => Promise<void>
    }
  ) {
    mockDom.props = props
    useImperativeHandle(
      props.ref,
      () => ({
        write: (data: string) => mockDom.ops.push(`write ${data}`),
        reset: () => mockDom.ops.push('reset'),
        resize: (cols: number, rows: number) => mockDom.ops.push(`resize ${cols}x${rows}`),
        requestText: (kind: string) => mockDom.ops.push(`text ${kind}`)
      }),
      []
    )
    // Ready once, as the web view's terminal is (a page load).
    const [onReady] = useState(() => props.onReady)
    useEffect(() => {
      void onReady()
    }, [onReady])
    return null
  }
  return { __esModule: true, default: FakeTerminalDom }
})

/** The direct link `useDirectLease` hands the view (null: the hub relays). */
const mockDirect = {
  lease: null as null | { client: unknown },
  lost: jest.fn()
}
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  useDirectLease: () => ({ lease: mockDirect.lease, lost: mockDirect.lost })
}))

beforeEach(() => {
  mockPrefs.text = null
  mockDom.ops = []
  mockDom.props = null
  mockDirect.lease = null
  mockDirect.lost.mockReset()
})

const SID = 't:t'

/** A recorded input without its random write id. */
function withoutWriteId(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !('writeId' in input)) return input
  const { writeId: _id, ...rest } = input as Record<string, unknown>
  return rest
}

function hub(
  opts: { offline?: () => boolean; attach?: () => unknown; submitResult?: boolean } = {}
) {
  const calls: Array<[string, unknown]> = []
  let emitData: (data: unknown) => void = () => undefined
  let emitResize: (data: unknown) => void = () => undefined
  let emitAvailability: (data: unknown) => void = () => undefined
  const dataInputs: unknown[] = []
  const record =
    (path: string, answer: unknown = true) =>
    (input: unknown) => {
      calls.push([path, input])
      return answer
    }
  const test = trpcTest({
    procedures: {
      'pty.attach': () =>
        opts.attach
          ? opts.attach()
          : opts.offline?.()
            ? {
                exists: true,
                state: 'running',
                buffer: null,
                size: { cols: 100, rows: 30 },
                unavailable: 'computer-offline'
              }
            : {
                exists: true,
                state: 'running',
                buffer: { chunks: [{ seq: 0, data: 'hello ' }], currentSeq: 0, prelude: '' },
                size: { cols: 100, rows: 30 }
              },
      'pty.getBufferSince': () => ({ chunks: [], currentSeq: 0, prelude: '' }),
      'pty.write': record('pty.write'),
      'pty.submit': record('pty.submit', opts.submitResult),
      'pty.interrupt': record('pty.interrupt'),
      'pty.touch': record('pty.touch')
    },
    subscriptions: {
      'pty.onData': (input, emit) => {
        dataInputs.push(input)
        emitData = emit
      },
      'pty.onResize': (_input, emit) => {
        emitResize = emit
      },
      'pty.onOutputAvailability': (_input, emit) => {
        emitAvailability = emit
      }
    }
  })
  return {
    ...test,
    calls,
    dataInputs,
    emitData: (d: unknown) => act(async () => emitData(d)),
    emitResize: (d: unknown) => act(async () => emitResize(d)),
    emitAvailability: (d: unknown) => act(async () => emitAvailability(d)),
    // Without the per-write `writeId` (a random id; terminal-controller.test pins it).
    of: (path: string) =>
      calls.filter(([p]) => p === path).map(([, input]) => withoutWriteId(input))
  }
}

/** Everything written to the terminal, as one string. */
const written = () =>
  mockDom.ops
    .filter((op) => op.startsWith('write '))
    .map((op) => op.slice('write '.length))
    .join('')

describe('TerminalView', () => {
  it("shows the session's output at the session's size, then live output", async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    await waitFor(() => expect(written()).toContain('hello '))
    expect(mockDom.ops).toContain('resize 100x30')
    // Only this session's bytes are streamed to the phone.
    expect(h.dataInputs).toEqual([{ sessionIds: [SID] }])

    await h.emitData({ sessionId: SID, seq: 1, data: 'world' })
    await waitFor(() => expect(written()).toBe('hello world'))
    await h.emitResize({ sessionId: 'other:other', cols: 10, rows: 10 })
    await h.emitResize({ sessionId: SID, cols: 90, rows: 20 })
    await waitFor(() => expect(mockDom.ops.at(-1)).toBe('resize 90x20'))
    expect(mockDom.ops).not.toContain('resize 10x10')
  })

  it('sends the key bar’s keys; Esc and ^C also interrupt, as on desktop', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    const user = userEvent.setup()
    await user.press(screen.getByLabelText('Escape'))
    await user.press(screen.getByLabelText('Arrow up'))
    await waitFor(() =>
      expect(h.of('pty.write')).toEqual([
        { sessionId: SID, data: '\x1b' },
        { sessionId: SID, data: '\x1b[A' }
      ])
    )
    expect(h.of('pty.interrupt')).toEqual([{ sessionId: SID }])

    // The program switched the arrows to application mode.
    await act(async () => mockDom.props?.onModes(true))
    await user.press(screen.getByLabelText('Arrow up'))
    await waitFor(() =>
      expect(h.of('pty.write').at(-1)).toEqual({ sessionId: SID, data: '\x1bOA' })
    )
  })

  it('sends what a touch scroll gives the program (a full-screen agent scrolls)', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    await act(async () => mockDom.props?.onInput('\x1b[<64;3;2M'))
    await waitFor(() =>
      expect(h.of('pty.write')).toEqual([{ sessionId: SID, data: '\x1b[<64;3;2M' }])
    )
    // Through the ordered writer, as every keystroke: it carries the write id.
    expect(h.calls.find(([p]) => p === 'pty.write')?.[1]).toHaveProperty('writeId')
  })

  it('lifts the key bar and the message field above the keyboard', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    // The root measures its own frame, including any headers above it.
    expect(screen.getByTestId('terminal-view').props.onLayout).toBeInstanceOf(Function)
  })

  it('lays out the shortcuts beside the message field when the keyboard leaves little height', async () => {
    const measure = jest.spyOn(keyboardOverlap, 'useKeyboardOverlap').mockReturnValue({
      bottom: 164,
      availableHeight: 94,
      onLayout: jest.fn()
    })
    try {
      await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: hub().wrapper })
      expect(screen.getByTestId('terminal-area')).toBeOnTheScreen()
      expect(screen.getByLabelText('Escape')).toBeOnTheScreen()
      expect(screen.getByLabelText('Message to the agent')).toBeOnTheScreen()
      expect(StyleSheet.flatten(screen.getByTestId('terminal-view').props.style)).toMatchObject({
        paddingBottom: 164
      })
      expect(StyleSheet.flatten(screen.getByTestId('terminal-controls').props.style)).toMatchObject(
        {
          flexDirection: 'row'
        }
      )
    } finally {
      measure.mockRestore()
    }
  })

  it('says it is connecting until the output is in', async () => {
    let answer: (value: unknown) => void = () => undefined
    const h = hub({ attach: () => new Promise((resolve) => (answer = resolve)) })
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    expect(await screen.findByLabelText('Connecting to the agent')).toBeTruthy()
    await act(async () =>
      answer({
        exists: true,
        state: 'running',
        buffer: { chunks: [{ seq: 0, data: 'hi' }], currentSeq: 0, prelude: '' },
        size: { cols: 80, rows: 24 }
      })
    )
    await waitFor(() => expect(screen.queryByLabelText('Connecting to the agent')).toBeNull())
  })

  it('says the agent is not running (and how to start it) instead of a blank terminal', async () => {
    const h = hub({
      attach: () => ({ exists: false, state: null, buffer: null, size: null })
    })
    await render(
      <TerminalView
        sessionId={SID}
        taskId="t1"
        live={false}
        notRunningHint="Tap Start to run it."
      />,
      { wrapper: h.wrapper }
    )
    expect(await screen.findByText('The agent isn’t running. Tap Start to run it.')).toBeTruthy()
  })

  it('does not claim the agent is stopped while its state is still loading', async () => {
    const h = hub({
      attach: () => ({ exists: false, state: null, buffer: null, size: null })
    })
    await render(<TerminalView sessionId={SID} taskId="t1" live={false} stateLoading />, {
      wrapper: h.wrapper
    })
    await waitFor(() => expect(screen.queryByLabelText('Connecting to the agent')).toBeNull())
    expect(screen.queryByText(/isn’t running/)).toBeNull()
  })

  it('keeps the last output of a stopped agent on screen', async () => {
    const h = hub({
      attach: () => ({
        exists: false,
        state: null,
        buffer: { chunks: [{ seq: 0, data: 'bye' }], currentSeq: 0, prelude: '' },
        size: { cols: 80, rows: 24 }
      })
    })
    await render(<TerminalView sessionId={SID} taskId="t1" live={false} />, {
      wrapper: h.wrapper
    })
    await waitFor(() => expect(written()).toBe('bye'))
    expect(screen.queryByText(/isn’t running/)).toBeNull()
  })

  it('a failed load says so and retries on request', async () => {
    let fail = true
    const h = hub({
      attach: () => {
        if (fail) throw new Error('hub hiccup')
        return {
          exists: true,
          state: 'running',
          buffer: { chunks: [{ seq: 0, data: 'back' }], currentSeq: 0, prelude: '' },
          size: { cols: 80, rows: 24 }
        }
      }
    })
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    expect(await screen.findByText('Couldn’t load the agent’s output.')).toBeTruthy()
    fail = false
    await userEvent.setup().press(screen.getByLabelText('Retry loading the output'))
    await waitFor(() => expect(written()).toBe('back'))
    expect(screen.queryByText('Couldn’t load the agent’s output.')).toBeNull()
  })

  it('Ctrl then a typed letter sends Ctrl+letter (the letter is not typed)', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    const user = userEvent.setup()
    const ctrl = screen.getByLabelText('Control')
    await user.press(ctrl)
    expect(screen.getByLabelText('Control').props.accessibilityState).toMatchObject({
      selected: true
    })
    const input = screen.getByLabelText('Message to the agent')
    await act(async () => fireEvent.changeText(input, 'r'))
    await waitFor(() => expect(h.of('pty.write')).toEqual([{ sessionId: SID, data: '\x12' }]))
    expect(screen.getByLabelText('Message to the agent').props.value).toBe('')
    // Used up: the next letter is typed.
    await act(async () => fireEvent.changeText(input, 'r'))
    expect(screen.getByLabelText('Message to the agent').props.value).toBe('r')
    expect(screen.getByLabelText('Control').props.accessibilityState).toMatchObject({
      selected: false
    })
  })

  it('an arrow held down repeats', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    await userEvent.setup().longPress(screen.getByLabelText('Arrow up'), { duration: 600 })
    await waitFor(() => expect(h.of('pty.write').length).toBeGreaterThanOrEqual(3))
    const count = h.of('pty.write').length
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(h.of('pty.write')).toHaveLength(count)
    expect(new Set(h.of('pty.write').map((w) => (w as { data: string }).data))).toEqual(
      new Set(['\x1b[A'])
    )
  })

  it('the message field is for prose: several lines, spell-checked, in the theme’s keyboard', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    const input = screen.getByLabelText('Message to the agent')
    expect(input.props).toMatchObject({
      multiline: true,
      autoCorrect: true,
      spellCheck: true,
      submitBehavior: 'submit'
    })
    expect(['dark', 'light']).toContain(input.props.keyboardAppearance)
  })

  it('opens a web link the user tapped in the terminal', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    await act(async () => mockDom.props?.onOpenLink('https://example.com/x'))
    expect(openWebLink).toHaveBeenCalledWith('https://example.com/x')
  })

  it('copies the screen’s text, or shares the whole output', async () => {
    const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true)
    const share = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction', activityType: undefined })
    try {
      const h = hub()
      const ref: { current: TerminalViewHandle | null } = { current: null }
      const onHandle = (handle: TerminalViewHandle | null) => {
        ref.current = handle
      }
      await render(<TerminalView onHandle={onHandle} sessionId={SID} taskId="t1" live />, {
        wrapper: h.wrapper
      })
      await act(async () => ref.current?.exportText('screen', 'copy'))
      await waitFor(() => expect(mockDom.ops).toContain('text screen'))
      await act(async () => mockDom.props?.onText('$ ls\nREADME.md'))
      expect(copy).toHaveBeenCalledWith('$ ls\nREADME.md')
      expect(share).not.toHaveBeenCalled()

      await act(async () => ref.current?.exportText('all', 'share'))
      await waitFor(() => expect(mockDom.ops).toContain('text all'))
      await act(async () => mockDom.props?.onText('everything'))
      expect(share).toHaveBeenCalledWith({ message: 'everything' })
    } finally {
      copy.mockRestore()
      share.mockRestore()
    }
  })

  it('keeps the text size the user picks on this device (readable by default)', async () => {
    const h = hub()
    const ref: { current: TerminalViewHandle | null } = { current: null }
    const onHandle = (handle: TerminalViewHandle | null) => {
      ref.current = handle
    }
    const view = await render(
      <TerminalView onHandle={onHandle} sessionId={SID} taskId="t1" live />,
      {
        wrapper: h.wrapper
      }
    )
    expect(mockDom.props?.textSize).toBe('readable')
    expect(ref.current?.textSize()).toBe('readable')
    await act(async () => ref.current?.toggleTextSize())
    expect(mockDom.props?.textSize).toBe('fit')
    expect(JSON.parse(mockPrefs.text ?? '{}')).toEqual({ textSize: 'fit' })
    // A double tap in the terminal changes it too.
    await act(async () => mockDom.props?.onTextSize('readable'))
    expect(JSON.parse(mockPrefs.text ?? '{}')).toEqual({ textSize: 'readable' })
    await view.unmount()
    mockPrefs.text = JSON.stringify({ textSize: 'fit' })
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: hub().wrapper })
    expect(mockDom.props?.textSize).toBe('fit')
  })

  it('knows the grid a terminal the phone starts should have (its screen at a readable size)', async () => {
    const h = hub()
    const ref: { current: TerminalViewHandle | null } = { current: null }
    const onHandle = (handle: TerminalViewHandle | null) => {
      ref.current = handle
    }
    await render(<TerminalView onHandle={onHandle} sessionId={SID} taskId="t1" live={false} />, {
      wrapper: h.wrapper
    })
    expect(ref.current?.grid()).toBeUndefined()
    await act(async () =>
      fireEvent(screen.getByTestId('terminal-area'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 500 } }
      })
    )
    expect(ref.current?.grid()).toEqual(expect.objectContaining({ cols: expect.any(Number) }))
    expect(ref.current?.grid()?.cols).toBeGreaterThanOrEqual(60)
  })

  it('submits typed text (the agent’s own Enter); an empty send presses Enter', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Message to the agent'), 'fix the bug')
    await user.press(screen.getByLabelText('Send'))
    await waitFor(() =>
      expect(h.of('pty.submit')).toEqual([{ sessionId: SID, text: 'fix the bug' }])
    )
    expect(screen.getByLabelText('Message to the agent').props.value).toBe('')

    await user.press(screen.getByLabelText('Send'))
    await waitFor(() => expect(h.of('pty.write')).toEqual([{ sessionId: SID, data: '\r' }]))
  })

  it('keeps the draft when the terminal exits before the server accepts Send', async () => {
    const h = hub({ submitResult: false })
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    const user = userEvent.setup()
    const input = screen.getByLabelText('Message to the agent')
    await user.type(input, 'retry this prompt')
    expect(input.props.value).toBe('retry this prompt')
    await user.press(screen.getByLabelText('Send'))
    await waitFor(() =>
      expect(h.of('pty.submit')).toEqual([{ sessionId: SID, text: 'retry this prompt' }])
    )
    expect(screen.getByLabelText('Message to the agent').props.value).toBe('retry this prompt')
    expect(screen.getByText('Not sent: The terminal could not accept input')).toBeTruthy()
  })

  it('closes the keyboard: its own button while typing, or touching the terminal', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss')
    try {
      const h = hub()
      await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
      const input = screen.getByLabelText('Message to the agent')
      // Return sends (and keeps the keyboard up), so the field needs its own close.
      expect(screen.queryByLabelText('Hide keyboard')).toBeNull()
      await act(async () => fireEvent(input, 'focus'))
      await userEvent.setup().press(screen.getByLabelText('Hide keyboard'))
      expect(dismiss).toHaveBeenCalledTimes(1)
      await act(async () => fireEvent(input, 'blur'))
      expect(screen.queryByLabelText('Hide keyboard')).toBeNull()

      // The terminal is a web view: a touch there does not blur the field by itself.
      await act(async () => mockDom.props?.onInteract())
      expect(dismiss).toHaveBeenCalledTimes(2)
    } finally {
      dismiss.mockRestore()
    }
  })

  it('reports the user’s presence at most every 4 seconds (it keeps the agent from idle-closing)', async () => {
    let now = 1_000_000
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const h = hub()
      await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
      await waitFor(() => expect(h.of('pty.touch')).toHaveLength(1)) // opened
      const user = userEvent.setup()
      await user.press(screen.getByLabelText('Tab'))
      await act(async () => mockDom.props?.onInteract())
      expect(h.of('pty.touch')).toHaveLength(1)
      now += 4_001
      await user.press(screen.getByLabelText('Tab'))
      await waitFor(() => expect(h.of('pty.touch')).toHaveLength(2))
    } finally {
      clock.mockRestore()
    }
  })

  it("says the session's computer is offline, then shows its output once it is back", async () => {
    let offline = true
    const h = hub({ offline: () => offline })
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    const note = 'The computer running this agent is offline. Its output resumes when it’s back.'
    await waitFor(() => expect(screen.getByText(note)).toBeTruthy())
    expect(written()).toBe('')
    offline = false
    await h.emitAvailability({ sessionId: SID, available: true })
    await waitFor(() => expect(written()).toContain('hello '))
    expect(screen.queryByText(note)).toBeNull()
  })

  it('names the offline computer when it knows it', async () => {
    const h = hub({ offline: () => true })
    await render(<TerminalView sessionId={SID} taskId="t1" live computerName="Mac Studio" />, {
      wrapper: h.wrapper
    })
    expect(
      await screen.findByText('Mac Studio is offline. Its output resumes when it’s back.')
    ).toBeTruthy()
  })

  it('sends nothing while no agent runs', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live={false} />, { wrapper: h.wrapper })
    await userEvent.setup().press(screen.getByLabelText('Escape'))
    await act(async () => mockDom.props?.onInput('\x1b[A'))
    await act(async () => undefined)
    expect(h.of('pty.write')).toEqual([])
    expect(h.of('pty.interrupt')).toEqual([])
  })
})

describe('TerminalView: direct link', () => {
  function directLease() {
    const writes: unknown[] = []
    let emit: ((e: { sessionId: string; seq: number; data: string }) => void) | undefined
    let started: (() => void) | undefined
    let end: (() => void) | undefined
    const client = {
      pty: {
        onData: {
          subscribe: (
            _input: unknown,
            h: { onStarted: () => void; onData: typeof emit; onComplete: () => void }
          ) => {
            emit = h.onData
            started = h.onStarted
            end = h.onComplete
            return { unsubscribe: () => undefined }
          }
        },
        attach: {
          query: async () => ({
            exists: true,
            size: { cols: 80, rows: 24 },
            buffer: { chunks: [{ seq: 0, data: 'direct ' }], currentSeq: 0, prelude: '' }
          })
        },
        getBufferSince: { query: async () => ({ chunks: [], currentSeq: 0, prelude: '' }) },
        write: {
          mutate: async (input: unknown) => {
            writes.push(withoutWriteId(input))
            return true
          }
        }
      }
    }
    return {
      lease: { client },
      writes,
      start: () => act(async () => started?.()),
      emit: (seq: number, data: string) => act(async () => emit?.({ sessionId: SID, seq, data })),
      end: () => act(async () => end?.())
    }
  }

  it('a touch scroll goes over the link too, in order with the keys', async () => {
    const d = directLease()
    mockDirect.lease = d.lease
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    await d.start()
    await act(async () => mockDom.props?.onInput('\x1b[<64;3;2M'))
    await waitFor(() => expect(d.writes).toEqual([{ sessionId: SID, data: '\x1b[<64;3;2M' }]))
    expect(h.of('pty.write')).toEqual([])
  })

  it('streams from the computer, not the hub, and types to it; submit stays a hub call', async () => {
    const d = directLease()
    mockDirect.lease = d.lease
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    await d.start()
    await waitFor(() => expect(written()).toContain('direct '))
    // The hub was never asked to relay this session.
    expect(h.dataInputs).toEqual([])
    await d.emit(1, 'live')
    await waitFor(() => expect(written()).toBe('direct live'))

    const user = userEvent.setup()
    await user.press(screen.getByLabelText('Arrow up'))
    await waitFor(() => expect(d.writes).toEqual([{ sessionId: SID, data: '\x1b[A' }]))
    expect(h.of('pty.write')).toEqual([])
  })

  it('reports the link lost when its stream ends (the process exited, the grant ended)', async () => {
    const d = directLease()
    mockDirect.lease = d.lease
    const h = hub()
    await render(<TerminalView sessionId={SID} taskId="t1" live />, { wrapper: h.wrapper })
    await d.end()
    expect(mockDirect.lost).toHaveBeenCalled()
  })
})
