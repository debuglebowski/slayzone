/**
 * A terminal's keystrokes reach the computer in the order they were typed, whichever
 * path each takes (docs/direct-link.md): a direct write that falls back to the hub
 * must not be overtaken by a later key that went direct.
 */
import { describe, expect, it } from 'vitest'
import { createOrderedPtyWriter } from './direct-write-order'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('ordered pty writer', () => {
  it('a later key waits for a direct write still in flight, then goes after it (coalesced)', async () => {
    let direct = true
    const sent: Array<[string, string]> = []
    const pending: Array<ReturnType<typeof deferred<boolean>>> = []
    const writer = createOrderedPtyWriter({
      isDirect: () => direct,
      send: (path, data) => {
        sent.push([path, data])
        const d = deferred<boolean>()
        pending.push(d)
        return d.promise
      }
    })
    const a = writer.write('a')
    const b = writer.write('b')
    const c = writer.write('c')
    await flush()
    expect(sent).toEqual([['direct', 'a']])
    // 'a' fell back to the hub and the link dropped meanwhile; 'b','c' follow it.
    direct = false
    pending[0]?.resolve(true)
    expect(await a).toBe(true)
    await flush()
    expect(sent).toEqual([
      ['direct', 'a'],
      ['hub', 'bc']
    ])
    pending[1]?.resolve(true)
    expect(await b).toBe(true)
    expect(await c).toBe(true)
  })

  it('hub-only writes are not held back: they pipeline, as before', async () => {
    const sent: string[] = []
    const writer = createOrderedPtyWriter({
      isDirect: () => false,
      send: (_path, data) => {
        sent.push(data)
        return new Promise<boolean>(() => undefined)
      }
    })
    void writer.write('a')
    void writer.write('b')
    await flush()
    expect(sent).toEqual(['a', 'b'])
  })

  it('a key that goes direct waits for hub writes still in flight', async () => {
    let direct = false
    const sent: Array<[string, string]> = []
    const hubA = deferred<boolean>()
    const writer = createOrderedPtyWriter({
      isDirect: () => direct,
      send: (path, data) => {
        sent.push([path, data])
        return path === 'hub' ? hubA.promise : Promise.resolve(true)
      }
    })
    void writer.write('a')
    await flush()
    direct = true
    const b = writer.write('b')
    await flush()
    expect(sent).toEqual([['hub', 'a']])
    hubA.resolve(true)
    expect(await b).toBe(true)
    expect(sent).toEqual([
      ['hub', 'a'],
      ['direct', 'b']
    ])
  })

  it('a failed write rejects its own callers only; the next ones still go', async () => {
    let n = 0
    const writer = createOrderedPtyWriter({
      isDirect: () => true,
      send: async () => {
        n++
        if (n === 1) throw new Error('both paths failed')
        return true
      }
    })
    const a = writer.write('a')
    const b = writer.write('b')
    await expect(a).rejects.toThrow('both paths failed')
    expect(await b).toBe(true)
  })
})
