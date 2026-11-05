import {
  type ScrollModes,
  ScrollAccumulator,
  scrollGoesToProgram,
  touchScrollBytes,
  wheelBytes
} from './touch-scroll'

const at = { col: 3, row: 7, x: 25, y: 61 }
const modes = (over: Partial<ScrollModes>): ScrollModes => ({
  mouseTracking: 'none',
  mouseEncoding: 'default',
  alternateScreen: false,
  applicationCursorKeys: false,
  ...over
})

describe('touch scroll (xterm 6.1 rules)', () => {
  it('goes to the program when it reports the wheel or is on the alternate screen', () => {
    expect(scrollGoesToProgram(modes({}))).toBe(false)
    expect(scrollGoesToProgram(modes({ mouseTracking: 'x10' }))).toBe(false) // presses only
    for (const t of ['vt200', 'drag', 'any'] as const)
      expect(scrollGoesToProgram(modes({ mouseTracking: t }))).toBe(true)
    expect(scrollGoesToProgram(modes({ alternateScreen: true }))).toBe(true)
  })

  it('encodes a wheel notch as xterm does', () => {
    expect(wheelBytes(true, at, 'sgr')).toBe('\x1b[<64;3;7M')
    expect(wheelBytes(false, at, 'sgr')).toBe('\x1b[<65;3;7M')
    expect(wheelBytes(true, at, 'sgr-pixels')).toBe('\x1b[<64;25;61M')
    expect(wheelBytes(false, at, 'default')).toBe(`\x1b[M${String.fromCharCode(97, 35, 39)}`)
    // X10 bytes stop at cell 223.
    expect(wheelBytes(true, { ...at, col: 224 }, 'default')).toBe('')
  })

  it('sends a notch per line, or arrows when the wheel is not reported', () => {
    expect(touchScrollBytes(-2, modes({ mouseTracking: 'any', mouseEncoding: 'sgr' }), at)).toBe(
      '\x1b[<64;3;7M\x1b[<64;3;7M'
    )
    expect(touchScrollBytes(1, modes({ alternateScreen: true }), at)).toBe('\x1b[B')
    expect(
      touchScrollBytes(-1, modes({ alternateScreen: true, applicationCursorKeys: true }), at)
    ).toBe('\x1bOA')
  })

  it('turns dragged pixels into whole lines, keeping the remainder; finger down = up', () => {
    const acc = new ScrollAccumulator()
    expect(acc.lines(5, 10)).toBe(0)
    expect(acc.lines(6, 10)).toBe(-1) // 11px down
    expect(acc.lines(9, 10)).toBe(-1) // 1 + 9
    expect(acc.lines(-25, 10)).toBe(2)
    acc.reset()
    expect(acc.lines(-9, 10)).toBe(0)
    expect(acc.lines(1, 0)).toBe(0)
  })
})
