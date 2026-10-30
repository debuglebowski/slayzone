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
    modes: { applicationCursorKeysMode: false },
    parser: {
      registerCsiHandler: (id: { prefix?: string; final: string }) => {
        handlers.push({ id })
        return { dispose: () => undefined }
      }
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

/** A 390px wide screen; each column is 0.6 × the font size wide. */
function host(width = 390): XtermHost & { term?: { cols: number; options: { fontSize: number } } } {
  const h: XtermHost & { term?: { cols: number; options: { fontSize: number } } } = {
    element: {} as HTMLElement,
    viewportWidth: () => width,
    screenWidth: () => (h.term ? h.term.cols * h.term.options.fontSize * 0.6 : 0)
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
    expect(fake.handlers.map((h) => `${h.id.prefix ?? ''}${h.id.final}`).sort()).toEqual([
      '>q',
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
