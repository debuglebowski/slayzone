/**
 * Pins xterm.js #6081 (in the 6.1 betas built from c58ea36 on): `ESC[3J` — erase
 * saved lines, what `clear` and an agent's own clear-screen send — must release a
 * viewport the user had scrolled up into that scrollback. Before the fix the
 * user-scrolling flag outlived the lines it pointed into, so the viewport stayed
 * pinned to the top while new output streamed in below it.
 *
 * Runs the installed `@xterm/headless`: the fix lives in xterm's shared core
 * (InputHandler), and every @xterm/* package moves in lockstep with it (see this
 * package's package.json `//xterm`), so this guards the renderer's @xterm/xterm too.
 */
// `@xterm/headless` ships CJS only. Under tsx's ESM interop the class can land on
// the namespace object OR under `.default`, so resolve both rather than pinning to
// whichever shape today's loader produces.
import { describe, expect, test } from 'vitest'
import * as headless from '@xterm/headless'

type HeadlessNs = {
  Terminal?: typeof headless.Terminal
  default?: { Terminal: typeof headless.Terminal }
}
const ns = headless as unknown as HeadlessNs
const Terminal = ns.Terminal ?? ns.default?.Terminal
if (!Terminal) throw new Error('could not resolve Terminal from @xterm/headless')

const write = (term: headless.Terminal, data: string): Promise<void> =>
  new Promise((resolve) => term.write(data, resolve))
const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}\r\n`).join('')

describe('xterm ESC[3J and a scrolled-up viewport', () => {
  test('erasing the scrollback the user scrolled into lets the viewport follow output again', async () => {
    const term = new Terminal({ cols: 10, rows: 5, scrollback: 1000 })
    const buf = () => term.buffer.active
    await write(term, lines('old', 20))
    term.scrollLines(-5)
    expect(buf().viewportY, 'precondition: the user scrolled up').toBeLessThan(buf().baseY)

    await write(term, '\x1b[3J')
    await write(term, lines('new', 20))

    expect(buf().viewportY, 'viewport stayed pinned above the new output').toBe(buf().baseY)
    term.dispose()
  })

  test('ESC[3J on the alt screen leaves the normal screen scrolled where the user put it', async () => {
    const term = new Terminal({ cols: 10, rows: 5, scrollback: 1000 })
    const buf = () => term.buffer.active
    await write(term, lines('old', 20))
    term.scrollLines(-5)
    const scrolledTo = buf().viewportY

    await write(term, '\x1b[?1049h')
    await write(term, lines('alt', 20))
    await write(term, '\x1b[3J\x1b[?1049l')
    expect(buf().viewportY).toBe(scrolledTo)

    await write(term, 'more\r\n')
    expect(buf().viewportY, 'new output yanked a deliberately scrolled-up viewport').toBe(
      scrolledTo
    )
    term.dispose()
  })
})
