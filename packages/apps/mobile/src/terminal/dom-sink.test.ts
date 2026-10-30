import { createDomSink, type DomTerminal } from './dom-sink'

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
})
