import { createDomSink, type DomTerminal, MAX_WRITE, WRITES_PER_FRAME } from './dom-sink'

function setup() {
  const calls: string[] = []
  const terminal: DomTerminal = {
    write: (data) => calls.push(`write ${data}`),
    reset: () => calls.push('reset'),
    resize: (cols, rows) => calls.push(`resize ${cols}x${rows}`)
  }
  let pending: (() => void) | null = null
  const schedule = (run: () => void) => {
    pending = run
  }
  const frame = () => {
    const run = pending
    pending = null
    run?.()
  }
  return { terminal, calls, schedule, frame, scheduled: () => pending !== null }
}

describe('createDomSink', () => {
  it('sends a frame’s writes as one write, in order with resets and resizes', () => {
    const s = setup()
    const sink = createDomSink(() => s.terminal, s.schedule)
    sink.reset()
    sink.resize(120, 40)
    sink.write('a')
    sink.write('b')
    sink.write('c')
    expect(s.calls).toEqual([])
    s.frame()
    expect(s.calls).toEqual(['reset', 'resize 120x40', 'write abc'])
  })

  it('schedules one flush per frame', () => {
    const s = setup()
    let scheduled = 0
    const sink = createDomSink(
      () => s.terminal,
      (run) => {
        scheduled++
        s.schedule(run)
      }
    )
    sink.write('a')
    sink.write('b')
    expect(scheduled).toBe(1)
    s.frame()
    sink.write('c')
    expect(scheduled).toBe(2)
  })

  it('holds everything while there is no terminal to send to', () => {
    const s = setup()
    let terminal: DomTerminal | null = null
    const sink = createDomSink(() => terminal, s.schedule)
    sink.write('a')
    s.frame()
    expect(s.calls).toEqual([])
    terminal = s.terminal
    sink.write('b')
    s.frame()
    expect(s.calls).toEqual(['write ab'])
  })

  it('sends what it held as soon as it is told the terminal exists', () => {
    const s = setup()
    let terminal: DomTerminal | null = null
    const sink = createDomSink(() => terminal, s.schedule)
    sink.write('a')
    s.frame()
    terminal = s.terminal
    sink.flush()
    expect(s.calls).toEqual(['write a'])
  })

  it('sends a large replay in pieces of at most 64KB, a few per frame, in order', () => {
    const s = setup()
    const sink = createDomSink(() => s.terminal, s.schedule)
    const big = 'x'.repeat(MAX_WRITE * (WRITES_PER_FRAME + 1) + 10)
    sink.write(big)
    sink.resize(80, 24)
    s.frame()
    const sizes = () => s.calls.map((c) => (c.startsWith('write ') ? c.length - 6 : c))
    expect(sizes()).toEqual(Array(WRITES_PER_FRAME).fill(MAX_WRITE))
    expect(s.scheduled()).toBe(true)
    s.frame()
    expect(sizes().slice(WRITES_PER_FRAME)).toEqual([MAX_WRITE, 10, 'resize 80x24'])
    expect(s.scheduled()).toBe(false)
    expect(
      s.calls
        .filter((c) => c.startsWith('write '))
        .map((c) => c.slice(6))
        .join('')
    ).toBe(big)
  })

  it('never cuts a character in two (a UTF-16 surrogate pair)', () => {
    const s = setup()
    const sink = createDomSink(() => s.terminal, s.schedule)
    sink.write(`${'a'.repeat(MAX_WRITE - 1)}😀b`)
    s.frame()
    expect(s.calls.map((c) => c.slice(6))).toEqual(['a'.repeat(MAX_WRITE - 1), '😀b'])
  })
})
