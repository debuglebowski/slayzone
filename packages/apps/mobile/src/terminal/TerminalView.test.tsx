import { act, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import { Keyboard } from 'react-native'
import { trpcTest } from '../testing'
import { TerminalView } from './TerminalView'

/** What the web view's terminal was sent, and the props it got. */
const mockDom = {
  ops: [] as string[],
  props: null as null | {
    onModes: (applicationCursorKeys: boolean) => Promise<void>
    onInteract: () => Promise<void>
    onInput: (data: string) => Promise<void>
  }
}

// The web view (a DOM component) cannot run in Node: a stand-in with its handle.
jest.mock('./TerminalDom', () => {
  const { useEffect, useImperativeHandle, useState } = jest.requireActual('react')
  function FakeTerminalDom(props: {
    ref: unknown
    onReady: () => Promise<void>
    onModes: (applicationCursorKeys: boolean) => Promise<void>
    onInteract: () => Promise<void>
    onInput: (data: string) => Promise<void>
  }) {
    mockDom.props = props
    useImperativeHandle(
      props.ref,
      () => ({
        write: (data: string) => mockDom.ops.push(`write ${data}`),
        reset: () => mockDom.ops.push('reset'),
        resize: (cols: number, rows: number) => mockDom.ops.push(`resize ${cols}x${rows}`)
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
  mockDom.ops = []
  mockDom.props = null
  mockDirect.lease = null
  mockDirect.lost.mockReset()
})

const SID = 't:t'

function hub(opts: { offline?: () => boolean } = {}) {
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
        opts.offline?.()
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
      'pty.submit': record('pty.submit'),
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
    of: (path: string) => calls.filter(([p]) => p === path).map(([, input]) => input)
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
    await render(<TerminalView sessionId={SID} live />, { wrapper: h.wrapper })
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
    await render(<TerminalView sessionId={SID} live />, { wrapper: h.wrapper })
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
    await render(<TerminalView sessionId={SID} live />, { wrapper: h.wrapper })
    await act(async () => mockDom.props?.onInput('\x1b[<64;3;2M'))
    await waitFor(() =>
      expect(h.of('pty.write')).toEqual([{ sessionId: SID, data: '\x1b[<64;3;2M' }])
    )
  })

  it('submits typed text (the agent’s own Enter); an empty send presses Enter', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} live />, { wrapper: h.wrapper })
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

  it('closes the keyboard: its own button while typing, or touching the terminal', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss')
    try {
      const h = hub()
      await render(<TerminalView sessionId={SID} live />, { wrapper: h.wrapper })
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
      await render(<TerminalView sessionId={SID} live />, { wrapper: h.wrapper })
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
    await render(<TerminalView sessionId={SID} live />, { wrapper: h.wrapper })
    await waitFor(() => expect(screen.getByText('Computer offline')).toBeTruthy())
    expect(written()).toBe('')
    offline = false
    await h.emitAvailability({ sessionId: SID, available: true })
    await waitFor(() => expect(written()).toContain('hello '))
    expect(screen.queryByText('Computer offline')).toBeNull()
  })

  it('sends nothing while no agent runs', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} live={false} />, { wrapper: h.wrapper })
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
            writes.push(input)
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

  it('streams from the computer, not the hub, and types to it; submit stays a hub call', async () => {
    const d = directLease()
    mockDirect.lease = d.lease
    const h = hub()
    await render(<TerminalView sessionId={SID} live />, { wrapper: h.wrapper })
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
    await render(<TerminalView sessionId={SID} live />, { wrapper: h.wrapper })
    await d.end()
    expect(mockDirect.lost).toHaveBeenCalled()
  })
})
