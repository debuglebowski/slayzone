/**
 * @vitest-environment jsdom
 *
 * The web shell's streaming save targets. jsdom has no Worker, so the zip runs through
 * the same encoder inline (`createZipSink` is injectable); zip-stream.test.ts covers the
 * encoder, and the web-shell e2e group covers the real worker under the hub's CSP.
 */
import { unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('mermaid/dist/mermaid.min.js?url', () => ({ default: '/assets/mermaid.min.js' }))

import { createBrowserSaveTargets, inlineZipSink } from './client-save'

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

  it('abort downloads nothing; an unknown target is refused', async () => {
    const targets = t()
    const id = await open(targets, { kind: 'zip', fileName: 'a.zip', title: 'x' })
    await targets.write(id, 'a.md', bytes('A'))
    await targets.abort(id)
    expect(clicked).toHaveLength(0)
    await expect(targets.write(id, 'a.md', bytes('A'))).rejects.toThrow('Unknown save target')
  })
})
