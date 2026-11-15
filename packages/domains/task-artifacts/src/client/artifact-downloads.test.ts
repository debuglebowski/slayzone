// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveTargetRequest } from '@slayzone/platform/electron-bootstrap-contract'
import {
  DOWNLOAD_CHUNK_BYTES,
  downloadArtifactOnThisDevice,
  downloadFolderOnThisDevice,
  downloadTaskZipOnThisDevice,
  type ReadArtifactChunk
} from './artifact-downloads'

// The host's streaming save target, recorded: which target opened, every write's path
// and size, whether it was closed or aborted. Bytes are only checksummed, never kept,
// so a test can push hundreds of MB through without holding them.
interface Recorded {
  request: SaveTargetRequest | null
  writes: { path: string; bytes: number }[]
  dirs: string[]
  sums: Map<string, number>
  closed: boolean
  aborted: boolean
}
let rec: Recorded
let openResult: unknown

function installHost() {
  rec = { request: null, writes: [], dirs: [], sums: new Map(), closed: false, aborted: false }
  openResult = { ok: true, targetId: 't1' }
  const app = {
    saveTargetOpen: vi.fn(async (req: SaveTargetRequest) => {
      rec.request = req
      return openResult
    }),
    saveTargetWrite: vi.fn(async (_id: string, path: string, data: Uint8Array) => {
      rec.writes.push({ path, bytes: data.byteLength })
      let sum = rec.sums.get(path) ?? 0
      for (let i = 0; i < data.length; i += 4096) sum = (sum + data[i]) % 1_000_003
      rec.sums.set(path, sum)
    }),
    saveTargetMkdir: vi.fn(async (_id: string, path: string) => {
      rec.dirs.push(path)
    }),
    saveTargetClose: vi.fn(async () => {
      rec.closed = true
      return { ok: true }
    }),
    saveTargetAbort: vi.fn(async () => {
      rec.aborted = true
    })
  }
  ;(window as unknown as { api: unknown }).api = { app, files: {} }
  return app
}

/** Synthetic artifacts: byte i of file `id` is (i * seed) & 255; generated per chunk. */
function fakeHub(files: Record<string, { size: number; seed: number } | 'missing' | 'broken'>) {
  let inFlight = 0
  let maxInFlight = 0
  let maxLength = 0
  const read: ReadArtifactChunk = async (id, offset, length) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    maxLength = Math.max(maxLength, length)
    await new Promise((r) => setTimeout(r, 0))
    inFlight--
    const f = files[id]
    if (f === 'missing' || f === undefined) return null
    if (f === 'broken') throw new Error('EIO: i/o error')
    const n = Math.max(0, Math.min(length, f.size - offset))
    const data = new Uint8Array(n)
    for (let i = 0; i < n; i++) data[i] = ((offset + i) * f.seed) & 255
    return { data, size: f.size, version: `v${f.seed}:${f.size}` }
  }
  return { read, stats: () => ({ maxInFlight, maxLength }) }
}

function expectedSum(size: number, seed: number): number {
  let sum = 0
  for (let chunk = 0; chunk < size; chunk += DOWNLOAD_CHUNK_BYTES) {
    const end = Math.min(size, chunk + DOWNLOAD_CHUNK_BYTES)
    for (let i = chunk; i < end; i += 4096) sum = (sum + ((i * seed) & 255)) % 1_000_003
  }
  return sum
}

const folders = [
  { id: 'f1', name: 'docs', parent_id: null },
  { id: 'f2', name: 'empty', parent_id: 'f1' }
]

beforeEach(() => {
  installHost()
})
afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('streaming a large artifact', () => {
  it('600 MB in bounded pieces: ≤ 2 reads in flight, no piece above the chunk size', async () => {
    const size = 600 * 1024 * 1024 + 123
    const hub = fakeHub({ big: { size, seed: 7 } })
    const outcome = await downloadArtifactOnThisDevice(
      { id: 'big', title: 'big.bin', folder_id: null },
      hub.read
    )
    expect(outcome).toEqual({ saved: true, skipped: [] })
    expect(rec.request).toEqual({ kind: 'file', fileName: 'big.bin', title: 'Download Artifact' })
    expect(rec.writes.reduce((n, w) => n + w.bytes, 0)).toBe(size)
    expect(Math.max(...rec.writes.map((w) => w.bytes))).toBeLessThanOrEqual(DOWNLOAD_CHUNK_BYTES)
    expect(rec.sums.get('')).toBe(expectedSum(size, 7))
    expect(hub.stats().maxInFlight).toBeLessThanOrEqual(2)
    expect(hub.stats().maxLength).toBe(DOWNLOAD_CHUNK_BYTES)
    expect(rec.closed).toBe(true)
  }, 60_000)
})

describe('downloadArtifactOnThisDevice', () => {
  it('names the file safely and saves an empty file too', async () => {
    const hub = fakeHub({ e: { size: 0, seed: 1 } })
    await downloadArtifactOnThisDevice(
      { id: 'e', title: '../../.zshrc', folder_id: null },
      hub.read
    )
    expect(rec.request).toMatchObject({ kind: 'file', fileName: '.zshrc' })
    expect(rec.writes).toEqual([{ path: '', bytes: 0 }])
  })

  it('throws when the file is gone, before opening a save dialog', async () => {
    const hub = fakeHub({ gone: 'missing' })
    await expect(
      downloadArtifactOnThisDevice({ id: 'gone', title: 'g.md', folder_id: null }, hub.read)
    ).rejects.toThrow('not found')
    expect(rec.request).toBeNull()
  })

  it('is not saved when the person cancels', async () => {
    openResult = { ok: false, canceled: true }
    const hub = fakeHub({ a: { size: 3, seed: 1 } })
    expect(
      await downloadArtifactOnThisDevice({ id: 'a', title: 'a.md', folder_id: null }, hub.read)
    ).toEqual({ saved: false, skipped: [] })
  })
})

describe('downloadFolderOnThisDevice', () => {
  it('writes the tree, empty folders included, and REPORTS files it could not find', async () => {
    const hub = fakeHub({ b: { size: 5, seed: 3 }, gone: 'missing' })
    const outcome = await downloadFolderOnThisDevice(
      folders,
      [
        { id: 'b', title: 'top.md', folder_id: 'f1' },
        { id: 'gone', title: 'gone.md', folder_id: 'f1' }
      ],
      'f1',
      hub.read
    )
    expect(outcome).toEqual({ saved: true, skipped: ['docs/gone.md'] })
    expect(rec.request).toEqual({
      kind: 'directory',
      folderName: 'docs',
      title: 'Download Folder To'
    })
    expect(rec.dirs).toEqual(['docs', 'docs/empty'])
    expect(rec.writes).toEqual([{ path: 'docs/top.md', bytes: 5 }])
  })

  it('a read error aborts the download and is thrown, never a silent omission', async () => {
    const hub = fakeHub({ b: 'broken' })
    await expect(
      downloadFolderOnThisDevice(
        folders,
        [{ id: 'b', title: 'top.md', folder_id: 'f1' }],
        'f1',
        hub.read
      )
    ).rejects.toThrow('EIO')
    expect(rec.aborted).toBe(true)
    expect(rec.closed).toBe(false)
  })
})

describe('downloadTaskZipOnThisDevice', () => {
  it('streams every artifact into a zip target at its folder path', async () => {
    const hub = fakeHub({ a: { size: 2, seed: 1 }, b: { size: 9, seed: 2 } })
    const outcome = await downloadTaskZipOnThisDevice(
      folders,
      [
        { id: 'a', title: 'root.md', folder_id: null },
        { id: 'b', title: 'top.md', folder_id: 'f1' }
      ],
      hub.read
    )
    expect(outcome).toEqual({ saved: true, skipped: [] })
    expect(rec.request).toEqual({
      kind: 'zip',
      fileName: 'artifacts.zip',
      title: 'Download All as ZIP',
      reveal: true
    })
    expect(rec.writes.map((w) => w.path)).toEqual(['root.md', 'docs/top.md'])
  })

  it('nothing to save with no artifacts', async () => {
    expect(await downloadTaskZipOnThisDevice(folders, [], fakeHub({}).read)).toEqual({
      saved: false,
      skipped: []
    })
  })
})

// Review 2, M1: an artifact rewritten while it downloads must never be saved truncated
// or spliced. The first piece pins the version; any later piece from another version
// aborts the download (partial removed) with a clear error.
describe('an artifact that changes mid-download', () => {
  const big = DOWNLOAD_CHUNK_BYTES * 2 + 10
  function changing(after: { size: number; version: string }): ReadArtifactChunk {
    return async (_id, offset, length) => {
      const size = offset === 0 ? big : after.size
      const n = Math.max(0, Math.min(length, size - offset))
      return { data: new Uint8Array(n), size, version: offset === 0 ? 'v1' : after.version }
    }
  }

  it('truncated after the first piece: aborted, never a short "complete" file', async () => {
    await expect(
      downloadArtifactOnThisDevice(
        { id: 'a', title: 'a.bin', folder_id: null },
        changing({ size: 0, version: 'v2' })
      )
    ).rejects.toThrow('changed while it was being downloaded')
    expect(rec.aborted).toBe(true)
    expect(rec.closed).toBe(false)
  })

  it('replaced by a same-sized version: aborted, never spliced', async () => {
    await expect(
      downloadTaskZipOnThisDevice(
        folders,
        [{ id: 'a', title: 'a.bin', folder_id: null }],
        changing({ size: big, version: 'v2' })
      )
    ).rejects.toThrow('changed while it was being downloaded')
    expect(rec.aborted).toBe(true)
  })

  it('a size change alone is caught too', async () => {
    await expect(
      downloadArtifactOnThisDevice(
        { id: 'a', title: 'a.bin', folder_id: null },
        changing({ size: big + 5, version: 'v1' })
      )
    ).rejects.toThrow('changed while it was being downloaded')
  })
})

// Review 8, M3: the hub's read loop can stop early (EOF on a network/FUSE filesystem,
// a stat/read mismatch under an unchanged stamp) and answer with fewer bytes than the
// pinned size, same version. That is never a complete download.
describe('a piece that comes back short of the pinned size', () => {
  const size = DOWNLOAD_CHUNK_BYTES * 2 + 10
  /** Same version and size every time, but no byte past `cut` ever comes back. */
  function cutAt(cut: number): ReadArtifactChunk {
    return async (_id, offset, length) => {
      const n = Math.max(0, Math.min(length, cut - offset))
      return { data: new Uint8Array(n), size, version: 'v1' }
    }
  }

  for (const [name, cut] of [
    ['nothing at all', 0],
    ['an empty piece mid-way', DOWNLOAD_CHUNK_BYTES],
    ['the last bytes missing', DOWNLOAD_CHUNK_BYTES * 2 + 3]
  ] as const) {
    it(`${name}: aborted, never saved`, async () => {
      await expect(
        downloadArtifactOnThisDevice({ id: 'a', title: 'a.bin', folder_id: null }, cutAt(cut))
      ).rejects.toThrow('changed while it was being downloaded')
      // Before the first byte: no save dialog at all. Later: the target is aborted.
      if (cut === 0) expect(rec.request).toBeNull()
      else expect(rec.aborted).toBe(true)
      expect(rec.closed).toBe(false)
    })
  }

  it('short pieces that the rest follows are a complete download', async () => {
    // The hub may answer with fewer bytes than asked; the next read continues there.
    const halves: ReadArtifactChunk = async (_id, offset, length) => ({
      data: new Uint8Array(Math.max(0, Math.min(Math.ceil(length / 2), size - offset))),
      size,
      version: 'v1'
    })
    await downloadArtifactOnThisDevice({ id: 'a', title: 'a.bin', folder_id: null }, halves)
    expect(rec.closed).toBe(true)
    expect(rec.writes.reduce((n, w) => n + w.bytes, 0)).toBe(size)
  })

  it('a piece longer than asked for, or past the size: aborted', async () => {
    const long: ReadArtifactChunk = async (_id, offset, length) => ({
      data: new Uint8Array(offset === 0 ? length + 1 : Math.min(length, size - offset)),
      size,
      version: 'v1'
    })
    await expect(
      downloadTaskZipOnThisDevice(folders, [{ id: 'a', title: 'a.bin', folder_id: null }], long)
    ).rejects.toThrow('changed while it was being downloaded')
    expect(rec.aborted).toBe(true)
  })
})
