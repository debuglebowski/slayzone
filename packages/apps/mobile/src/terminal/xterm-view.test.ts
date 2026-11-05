import { Terminal as Headless } from '@xterm/headless'
import { clampZoom, fitFontSize, MAX_FONT, MIN_FONT, readableZoom } from './terminal-scale'
import { type TerminalLike, type XtermHost, XtermView } from './xterm-view'

/** A stand-in for xterm.js: records calls; the rendered width follows the font size. */
function fakeTerminal() {
  const calls: string[] = []
  const handlers: Array<{ id: { prefix?: string; final: string } }> = []
  const term = {
    cols: 80,
    rows: 24,
    options: { fontSize: 14 } as { fontSize: number; theme?: unknown },
    modes: { applicationCursorKeysMode: false, mouseTrackingMode: 'none' as string },
    buffer: { active: { type: 'normal' as string } },
    parser: {
      registerCsiHandler: (id: { prefix?: string; final: string }) => {
        handlers.push({ id })
        return { dispose: () => undefined }
      },
      registerEscHandler: () => ({ dispose: () => undefined })
    },
    open: () => calls.push('open'),
    write: (data: string, done?: () => void) => {
      calls.push(`write ${data}`)
      done?.()
    },
    reset: () => calls.push('reset'),
    resize: (cols: number, rows: number) => {
      term.cols = cols
      term.rows = rows
      calls.push(`resize ${cols}x${rows}`)
    },
    dispose: () => calls.push('dispose')
  }
  return { term: term as unknown as TerminalLike & typeof term, calls, handlers }
}

type Sized = { cols: number; rows: number; options: { fontSize?: number } }
/** A 390px wide screen at (0, 100); a cell is 0.6 × 1.2 the font size. */
function host(width = 390): XtermHost & { term?: Sized } {
  const h: XtermHost & { term?: Sized } = {
    element: {} as HTMLElement,
    viewportWidth: () => width,
    screenRect: () => {
      const font = h.term?.options.fontSize ?? 0
      return h.term
        ? { left: 0, top: 100, width: h.term.cols * font * 0.6, height: h.term.rows * font * 1.2 }
        : { left: 0, top: 0, width: 0, height: 0 }
    }
  }
  return h
}

function make(width = 390) {
  const fake = fakeTerminal()
  const h = host(width)
  h.term = fake.term
  const modes: boolean[] = []
  const view = new XtermView(() => fake.term, h, {
    onModes: (m) => modes.push(m.applicationCursorKeys)
  })
  return { view, fake, modes }
}

describe('terminal scale', () => {
  it('fits the columns to the screen width', () => {
    // 80 cols at 14px = 672px wide; the screen is 336px: half the font.
    expect(fitFontSize(14, 672, 336)).toBe(7)
    expect(fitFontSize(14, 10_000, 100)).toBe(MIN_FONT)
    expect(fitFontSize(14, 10, 1000)).toBe(MAX_FONT)
  })

  it('zooms between the fit and the largest font', () => {
    expect(clampZoom(0.5, 7)).toBe(1)
    expect(clampZoom(2, 7)).toBe(2)
    expect(clampZoom(100, 7)).toBe(MAX_FONT / 7)
    expect(readableZoom(6.5)).toBe(2)
    expect(readableZoom(20)).toBe(1)
  })
})

describe('XtermView', () => {
  it('is read-only and never answers device-status or version queries', () => {
    const fake = fakeTerminal()
    let options: Record<string, unknown> = {}
    new XtermView(
      (o) => {
        options = o as unknown as Record<string, unknown>
        return fake.term
      },
      host(),
      {}
    )
    expect(options.disableStdin).toBe(true)
    // Answer-suppression for the queries, plus the (non-consuming) mouse-encoding watch.
    expect(fake.handlers.map((h) => `${h.id.prefix ?? ''}${h.id.final}`).sort()).toEqual([
      '>q',
      '?h',
      '?l',
      '?n',
      'n'
    ])
  })

  it('renders at the session size, scaled so every column fits the screen', () => {
    const { view, fake } = make(390)
    view.resize(130, 40)
    expect(fake.calls).toContain('resize 130x40')
    // 130 columns × 0.6 × font = 390px → font 5.
    expect(fake.term.options.fontSize).toBeCloseTo(5)
  })

  it('writes, resets', () => {
    const { view, fake } = make()
    view.write('hello')
    view.reset()
    expect(fake.calls.slice(-2)).toEqual(['write hello', 'reset'])
  })

  it('reports the cursor-key mode when a write changes it', () => {
    const { view, fake, modes } = make()
    view.write('a')
    fake.term.modes.applicationCursorKeysMode = true
    view.write('\x1b[?1h')
    view.write('b')
    expect(modes).toEqual([true])
  })

  it('zooms with a pinch, never below the fit, and toggles fit ↔ readable on a double tap', () => {
    const { view, fake } = make(390)
    view.resize(130, 40) // fit font 5
    view.pinchStart()
    view.pinchMove(2)
    expect(fake.term.options.fontSize).toBeCloseTo(10)
    view.pinchStart()
    view.pinchMove(0.1)
    expect(fake.term.options.fontSize).toBeCloseTo(5)
    view.toggleZoom()
    expect(fake.term.options.fontSize).toBeCloseTo(13)
    view.toggleZoom()
    expect(fake.term.options.fontSize).toBeCloseTo(5)
  })

  it('keeps the zoom when the screen or the session size changes', () => {
    const { view, fake } = make(390)
    view.resize(130, 40)
    view.pinchStart()
    view.pinchMove(2)
    view.resize(65, 40) // fit font 10, still zoomed ×2
    expect(fake.term.options.fontSize).toBeCloseTo(20)
  })
})

/** The view over REAL xterm (headless: the same parser and modes as @xterm/xterm). */
function overXterm() {
  const term = new Headless({ cols: 100, rows: 30, allowProposedApi: true })
  const asLike = Object.assign(term, { open: () => undefined }) as unknown as TerminalLike
  const h = host(600) // 100 cols × 0.6 × 10px font → a 10px font fits; cells 6 × 12px
  h.term = asLike
  const input: string[] = []
  const view = new XtermView(() => asLike, h, { onInput: (d) => input.push(d) })
  const write = (data: string) => new Promise<void>((done) => term.write(data, done))
  return { term, view, input, write }
}

describe('XtermView touch scroll', () => {
  it('a full-screen agent (alternate screen + SGR mouse, as Claude Code) gets wheel notches', async () => {
    const { view, input, write } = overXterm()
    expect(view.touchScrollStart()).toBe(false) // plain shell: xterm scrolls the scrollback
    await write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')
    expect(view.touchScrollStart()).toBe(true)
    // Finger at cell (3, 2) drags 25px down (2 lines of 12px): two notches up.
    view.touchScrollMove(25, 15, 100 + 20)
    expect(input).toEqual(['\x1b[<64;3;2M\x1b[<64;3;2M'])
    view.touchScrollMove(-13, 15, 100 + 20)
    expect(input.at(-1)).toBe('\x1b[<65;3;2M')
  })

  it('follows the encoding xterm uses: X10 bytes after DECRST 1006 or a reset', async () => {
    const { view, input, write } = overXterm()
    await write('\x1b[?1000h\x1b[?1006h\x1b[?1006l')
    view.touchScrollStart()
    view.touchScrollMove(-12, 0, 100)
    expect(input).toEqual([`\x1b[M${String.fromCharCode(97, 33, 33)}`])
    await write('\x1b[?1006h\x1bc\x1b[?1000h') // RIS drops SGR; tracking back on
    view.touchScrollStart()
    view.touchScrollMove(-12, 0, 100)
    expect(input.at(-1)).toBe(`\x1b[M${String.fromCharCode(97, 33, 33)}`)
  })

  it('the alternate screen without the mouse gets arrow keys (in the cursor-key mode)', async () => {
    const { view, input, write } = overXterm()
    await write('\x1b[?1049h\x1b[?1h')
    expect(view.touchScrollStart()).toBe(true)
    view.touchScrollMove(12, 0, 100)
    expect(input).toEqual(['\x1bOA'])
  })
})
