/**
 * @vitest-environment jsdom
 */
import { unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('mermaid/dist/mermaid.min.js?url', () => ({ default: '/assets/mermaid.min.js' }))

import { saveFileInBrowser, saveFilesInBrowser } from './client-save'

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

describe('web shell downloads', () => {
  it('downloads one file under its name, bytes intact', async () => {
    const res = await saveFileInBrowser({
      fileName: 'pic.png',
      title: 'Download Artifact',
      data: new Uint8Array([137, 80, 78, 71])
    })
    expect(res).toEqual({ ok: true })
    expect(clicked[0].name).toBe('pic.png')
    expect(Array.from(new Uint8Array(await clicked[0].blob.arrayBuffer()))).toEqual([
      137, 80, 78, 71
    ])
  })

  it('downloads a folder as one zip, paths kept', async () => {
    await saveFilesInBrowser({
      folderName: 'docs',
      title: 'Download Folder To',
      files: [
        { path: 'docs/a.md', data: new TextEncoder().encode('A') },
        { path: 'docs/sub/b.md', data: new TextEncoder().encode('B') }
      ]
    })
    expect(clicked[0].name).toBe('docs.zip')
    const entries = unzipSync(new Uint8Array(await clicked[0].blob.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual(['docs/a.md', 'docs/sub/b.md'])
  })
})
