/**
 * @vitest-environment jsdom
 *
 * The web shell's streaming save targets. jsdom has no Worker, so the zip runs through
 * the same encoder inline (`createZipSink` is injectable); zip-stream.test.ts covers the
 * encoder, and the web-shell e2e group covers the real worker under the hub's CSP.
 */
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('mermaid/dist/mermaid.min.js?url', () => ({ default: '/assets/mermaid.min.js' }))

import { createBrowserSaveTargets, inlineZipSink, workerZipSink } from './client-save'

const clicked: { name: string; blob: Blob }[] = []

beforeEach(() => {
  clicked.length = 0
  const blobs = new Map<string, Blob>()
  let n = 0
  URL.createObjectURL = vi.fn((b: Blob) => {
    const url = `blob:test/${++n}`
    blobs.set(url, b as Blob)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push({ name: this.download, blob: blobs.get(this.href) as Blob })
  })
})

const t = () => createBrowserSaveTargets({ createZipSink: inlineZipSink })
const bytes = (s: string) => new TextEncoder().encode(s)

async function open(
  targets: ReturnType<typeof t>,
  req: Parameters<ReturnType<typeof t>['open']>[0]
) {
  const r = await targets.open(req)
  if (!r.ok) throw new Error('not opened')
  return r.targetId
}

describe('web shell save targets', () => {
  it('a file arrives as one download, pieces in order', async () => {
    const targets = t()
    const id = await open(targets, { kind: 'file', fileName: 'pic.bin', title: 'x' })
    await targets.write(id, '', new Uint8Array([0, 1]))
    await targets.write(id, '', new Uint8Array([254, 255]))
    expect(await targets.close(id)).toEqual({ ok: true })
    expect(clicked[0].name).toBe('pic.bin')
    expect(Array.from(new Uint8Array(await clicked[0].blob.arrayBuffer()))).toEqual([
      0, 1, 254, 255
    ])
  })

  it('a folder arrives as <name>.zip, paths and empty folders kept', async () => {
    const targets = t()
    const id = await open(targets, { kind: 'directory', folderName: 'docs', title: 'x' })
    await targets.mkdir(id, 'docs/empty')
    await targets.write(id, 'docs/a.md', bytes('A'))
    await targets.write(id, 'docs/sub/b.md', bytes('B'))
    await targets.close(id)
    expect(clicked[0].name).toBe('docs.zip')
    const entries = unzipSync(new Uint8Array(await clicked[0].blob.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual(['docs/a.md', 'docs/empty/', 'docs/sub/b.md'])
  })

  it('a zip target downloads under its own name', async () => {
    const targets = t()
    const id = await open(targets, { kind: 'zip', fileName: 'artifacts.zip', title: 'x' })
    await targets.write(id, 'a.md', bytes('A'))
    await targets.close(id)
    expect(clicked[0].name).toBe('artifacts.zip')
    expect(
      new TextDecoder().decode(
        unzipSync(new Uint8Array(await clicked[0].blob.arrayBuffer()))['a.md']
      )
    ).toBe('A')
  })

  it('a folder (zip) refuses a path already written, never appends to it', async () => {
    const targets = t()
    const id = await open(targets, { kind: 'directory', folderName: 'docs', title: 'x' })
    await targets.write(id, 'docs/a.md', bytes('first'))
    await targets.write(id, 'docs/b.md', bytes('other'))
    await expect(targets.write(id, 'docs/a.md', bytes('second'))).rejects.toThrow('already written')
  })

  it('abort downloads nothing; an unknown target is refused', async () => {
    const targets = t()
    const id = await open(targets, { kind: 'zip', fileName: 'a.zip', title: 'x' })
    await targets.write(id, 'a.md', bytes('A'))
    await targets.abort(id)
    expect(clicked).toHaveLength(0)
    await expect(targets.write(id, 'a.md', bytes('A'))).rejects.toThrow('Unknown save target')
  })
})

// Review 2, M4: the tab never holds the download as one growing buffer. Each piece (and
// each chunk of zip output) becomes its own Blob as it arrives — Chromium moves Blob
// data to browser-process storage, which pages to disk — and close only joins Blobs.
describe('memory shape', () => {
  function recordingBlobs() {
    const made: { parts: unknown[] }[] = []
    const makeBlob = (parts: BlobPart[], opts?: BlobPropertyBag) => {
      made.push({ parts })
      return new Blob(parts, opts)
    }
    return { made, makeBlob }
  }

  it('a file: one Blob per piece as it arrives, joined from Blobs at close', async () => {
    const { made, makeBlob } = recordingBlobs()
    const targets = createBrowserSaveTargets({ createZipSink: inlineZipSink, makeBlob })
    const id = await open(targets, { kind: 'file', fileName: 'f.bin', title: 'x' })
    for (let i = 0; i < 5; i++) await targets.write(id, '', new Uint8Array(1000).fill(i))
    expect(made).toHaveLength(5)
    for (const m of made) expect(m.parts).toHaveLength(1)
    await targets.close(id)
    const final = made[made.length - 1]
    expect(final.parts).toHaveLength(5)
    for (const p of final.parts) expect(p).toBeInstanceOf(Blob)
    expect((await clicked[0].blob.arrayBuffer()).byteLength).toBe(5000)
  })

  it('a zip: the archive output becomes Blobs as it is produced, not at close', async () => {
    const { made, makeBlob } = recordingBlobs()
    const targets = createBrowserSaveTargets({ createZipSink: inlineZipSink, makeBlob })
    const id = await open(targets, { kind: 'zip', fileName: 'z.zip', title: 'x' })
    await targets.write(
      id,
      'a.bin',
      new Uint8Array(50_000).map((_, i) => i & 255)
    )
    await targets.write(
      id,
      'b.bin',
      new Uint8Array(50_000).map((_, i) => (i * 3) & 255)
    )
    const beforeClose = made.length
    expect(beforeClose).toBeGreaterThan(0)
    await targets.close(id)
    const final = made[made.length - 1]
    for (const p of final.parts) expect(p).toBeInstanceOf(Blob)
  })
})

// Review 5, #9. The zip worker can die with nothing in flight: a tab left open across a
// hub upgrade asks for a hashed worker chunk that no longer exists (404), and the error
// arrives before the first request. Every request after that must fail, never hang.
describe('workerZipSink when the worker dies', () => {
  class FakeWorker {
    static last: FakeWorker | null = null
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: Event) => void) | null = null
    onmessageerror: ((e: MessageEvent) => void) | null = null
    posted: unknown[] = []
    terminated = false
    constructor() {
      FakeWorker.last = this
    }
    postMessage(msg: unknown) {
      this.posted.push(msg)
    }
    terminate() {
      this.terminated = true
    }
  }
  const realWorker = globalThis.Worker
  beforeEach(() => {
    globalThis.Worker = FakeWorker as unknown as typeof Worker
  })
  afterEach(() => {
    globalThis.Worker = realWorker
  })
  const settled = (p: Promise<unknown>) =>
    Promise.race([
      p.then(
        () => 'resolved',
        (e: Error) => `rejected: ${e.message}`
      ),
      new Promise((r) => setTimeout(() => r('pending'), 50))
    ])

  it('an error with nothing in flight fails every later request', async () => {
    const sink = workerZipSink(() => undefined)
    const worker = FakeWorker.last as FakeWorker
    worker.onerror?.(new Event('error'))
    expect(await settled(sink.write('a.md', bytes('A')))).toBe('rejected: The zip worker failed')
    expect(await settled(sink.mkdir('d'))).toBe('rejected: The zip worker failed')
    expect(await settled(sink.finish())).toBe('rejected: The zip worker failed')
    expect(worker.posted, 'nothing sent to a dead worker').toEqual([])
  })

  it('an error mid-request fails that request and every later one', async () => {
    const sink = workerZipSink(() => undefined)
    const worker = FakeWorker.last as FakeWorker
    const first = sink.write('a.md', bytes('A'))
    worker.onerror?.(Object.assign(new Event('error'), { message: 'boom' }))
    expect(await settled(first)).toBe('rejected: boom')
    expect(await settled(sink.write('b.md', bytes('B')))).toBe('rejected: boom')
  })

  it('a reply that cannot be deserialised fails the request and the sink', async () => {
    const sink = workerZipSink(() => undefined)
    const worker = FakeWorker.last as FakeWorker
    const first = sink.write('a.md', bytes('A'))
    worker.onmessageerror?.(new MessageEvent('messageerror'))
    expect(await settled(first)).toMatch(/^rejected: /)
    expect(await settled(sink.finish())).toMatch(/^rejected: /)
  })

  it('a request the worker cannot be sent fails, and so does every later one', async () => {
    const sink = workerZipSink(() => undefined)
    const worker = FakeWorker.last as FakeWorker
    worker.postMessage = () => {
      throw new DOMException('could not be cloned', 'DataCloneError')
    }
    expect(await settled(sink.write('a.md', bytes('A')))).toBe('rejected: could not be cloned')
    expect(await settled(sink.finish())).toBe('rejected: could not be cloned')
  })

  it('a healthy worker still answers in order', async () => {
    const out: Uint8Array[] = []
    const sink = workerZipSink((c) => out.push(c))
    const worker = FakeWorker.last as FakeWorker
    const p = sink.write('a.md', bytes('A'))
    const seq = (worker.posted[0] as { seq: number }).seq
    worker.onmessage?.(new MessageEvent('message', { data: { seq, out: [bytes('PK')] } }))
    expect(await settled(p)).toBe('resolved')
    expect(out).toHaveLength(1)
  })
})
