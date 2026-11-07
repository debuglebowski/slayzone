/**
 * A terminal's catch-up from the scrollback (`getBufferSince`) while live output
 * keeps arriving. Live chunks are held during it and merged by seq.
 *
 * Round-3 finding F1, the exact sequence: the tab-activation catch-up starts; live
 * chunks arrive and are held; the user switches tab (the catch-up is cancelled)
 * before the reply lands. The held chunks were thrown away, later live chunks moved
 * the rendered seq past them, and the next catch-up never asked for them again — a
 * hole in the output (it corrupts full-screen TUIs). Nothing may be dropped.
 */
import { describe, expect, it } from 'vitest'
import { createCatchUpController } from './catch-up-controller'

const c = (seq: number) => ({ seq, data: `<${seq}>` })

function setup() {
  const written: string[] = []
  let rendered = 10
  const fetches: Array<{
    afterSeq: number
    resolve: (r: { chunks: Array<{ seq: number; data: string }> }) => void
  }> = []
  const ctl = createCatchUpController({
    fetchSince: (afterSeq) => new Promise((resolve) => fetches.push({ afterSeq, resolve })),
    write: (chunk) => {
      written.push(chunk.data)
      rendered = chunk.seq
    },
    writePrelude: (p) => written.push(p),
    renderedSeq: () => rendered,
    clearedSeq: () => null,
    flushPending: () => undefined
  })
  // The live path: held while a catch-up runs, else written at once.
  const live = (seq: number) => {
    if (!ctl.hold(c(seq))) {
      written.push(`<${seq}>`)
      rendered = seq
    }
  }
  return { ctl, written, fetches, live, rendered: () => rendered }
}

describe('catch-up controller', () => {
  it('F1: held live chunks survive a cancelled catch-up — none lost, none twice', async () => {
    const { ctl, written, fetches, live } = setup()
    let cancelled = false
    const run = ctl.run(() => cancelled)
    await Promise.resolve()
    live(13)
    live(14) // held: the catch-up is in flight
    cancelled = true // the user switched tab
    fetches[0]!.resolve({ chunks: [c(11), c(12), c(13)] })
    await run
    live(15) // live again
    expect(written).toEqual(['<11>', '<12>', '<13>', '<14>', '<15>'])
  })

  it('a catch-up while another runs waits for it, then asks from where it left off', async () => {
    const { ctl, written, fetches } = setup()
    const first = ctl.run(() => false)
    const second = ctl.run(() => false) // the computer-reconnect catch-up
    await Promise.resolve()
    expect(fetches, 'one at a time').toHaveLength(1)
    fetches[0]!.resolve({ chunks: [c(11), c(12)] })
    await first
    await new Promise((r) => setTimeout(r, 0))
    expect(fetches[1]?.afterSeq).toBe(12)
    fetches[1]!.resolve({ chunks: [c(12), c(13)] })
    await second
    expect(written).toEqual(['<11>', '<12>', '<13>'])
  })

  it('a failed catch-up still writes what it held, and rejects', async () => {
    const written: string[] = []
    let rendered = 1
    const ctl = createCatchUpController({
      fetchSince: () => Promise.reject(new Error('offline')),
      write: (chunk) => {
        written.push(chunk.data)
        rendered = chunk.seq
      },
      writePrelude: () => undefined,
      renderedSeq: () => rendered,
      clearedSeq: () => null,
      flushPending: () => undefined
    })
    const run = ctl.run(() => false)
    await Promise.resolve()
    expect(ctl.hold(c(2)), 'held while in flight').toBe(true)
    await expect(run).rejects.toThrow('offline')
    expect(written).toEqual(['<2>'])
    expect(ctl.hold(c(3)), 'not holding once it ended').toBe(false)
  })
})
