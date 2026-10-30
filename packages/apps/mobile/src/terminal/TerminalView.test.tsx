import { act, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import { trpcTest } from '../testing'
import { TerminalView } from './TerminalView'

/** What the web view's terminal was sent, and the props it got. */
const mockDom = {
  ops: [] as string[],
  props: null as null | {
    onModes: (applicationCursorKeys: boolean) => Promise<void>
    onInteract: () => Promise<void>
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

beforeEach(() => {
  mockDom.ops = []
  mockDom.props = null
})

const SID = 't:t'

function hub() {
  const calls: Array<[string, unknown]> = []
  let emitData: (data: unknown) => void = () => undefined
  let emitResize: (data: unknown) => void = () => undefined
  const dataInputs: unknown[] = []
  const record =
    (path: string, answer: unknown = true) =>
    (input: unknown) => {
      calls.push([path, input])
      return answer
    }
  const test = trpcTest({
    procedures: {
      'pty.attach': () => ({
        exists: true,
        state: 'running',
        buffer: { chunks: [{ seq: 0, data: 'hello ' }], currentSeq: 0, prelude: '' },
        size: { cols: 100, rows: 30 }
      }),
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
      }
    }
  })
  return {
    ...test,
    calls,
    dataInputs,
    emitData: (d: unknown) => act(async () => emitData(d)),
    emitResize: (d: unknown) => act(async () => emitResize(d)),
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

  it('sends nothing while no agent runs', async () => {
    const h = hub()
    await render(<TerminalView sessionId={SID} live={false} />, { wrapper: h.wrapper })
    await userEvent.setup().press(screen.getByLabelText('Escape'))
    await act(async () => undefined)
    expect(h.of('pty.write')).toEqual([])
    expect(h.of('pty.interrupt')).toEqual([])
  })
})
