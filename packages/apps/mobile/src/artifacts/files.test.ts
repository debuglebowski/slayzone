import type { TaskArtifact } from '@slayzone/task-contracts'
import { hubEntryOf } from '../hub-session'
import { hubTarget } from './hub-rest'
import {
  ARTIFACT_CACHE_DIR,
  type ArtifactFileStore,
  artifactFileStamp,
  downloadArtifactFile,
  downloadStatusOf,
  forgetArtifactCache
} from './files'

const home = hubTarget({ entry: hubEntryOf('home.example'), token: 'h' })
const artifact = {
  id: 'a1',
  title: 'Shot: 1/2.png',
  current_version_id: 'v9',
  updated_at: '2026-10-30 10:00:00'
} as TaskArtifact

/** An in-memory cache: directories as `/`-joined paths, downloads answered by `answer`. */
function memoryStore(answer: (url: string) => number = () => 200) {
  const files = new Map<string, string>()
  const requests: Array<{ url: string; headers: Record<string, string>; path: string }> = []
  const store: ArtifactFileStore = {
    find: (dir, name) =>
      files.has(`${dir.join('/')}/${name}`) ? `file:///${dir.join('/')}/${name}` : null,
    download: async (url, headers, dir, name) => {
      const path = `${dir.join('/')}/${name}`
      requests.push({ url, headers, path })
      const status = answer(url)
      if (status !== 200)
        throw new Error(`Unable to download a file: response has status ${status}`)
      files.set(path, url)
      return `file:///${path}`
    },
    removeExcept: (dir, keep) => {
      const prefix = `${dir.join('/')}/`
      for (const path of [...files.keys()]) {
        if (path.startsWith(prefix) && (keep === null || !path.startsWith(`${prefix}${keep}/`))) {
          files.delete(path)
        }
      }
    }
  }
  return { store, files, requests }
}

describe('artifactFileStamp', () => {
  it('changes whenever the artifact’s content may have', () => {
    const a = artifactFileStamp({ artifact, contentTick: 0 })
    expect(artifactFileStamp({ artifact, contentTick: 1 })).not.toBe(a)
    expect(
      artifactFileStamp({ artifact: { ...artifact, current_version_id: 'v10' }, contentTick: 0 })
    ).not.toBe(a)
    expect(
      artifactFileStamp({
        artifact: { ...artifact, updated_at: '2026-10-30T11:00:00.000Z' },
        contentTick: 0
      })
    ).not.toBe(a)
    expect(artifactFileStamp({ artifact, contentTick: 0 })).toBe(a)
  })

  it('names a version by its content hash (immutable)', () => {
    expect(artifactFileStamp({ artifact, version: { ref: 2, contentHash: 'abc123' } })).toBe(
      'v-abc123'
    )
  })
})

describe('downloadArtifactFile', () => {
  it("downloads the working copy with the hub's bearer into the hub's cache, under the title", async () => {
    const { store, requests } = memoryStore()
    const uri = await downloadArtifactFile(home, { artifact, contentTick: 0 }, store)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://home.example/api/artifacts/a1/content')
    expect(requests[0].headers).toEqual({ authorization: 'Bearer h' })
    expect(requests[0].path.startsWith(`${ARTIFACT_CACHE_DIR}/`)).toBe(true)
    expect(
      requests[0].path.endsWith(
        '/a1/' + artifactFileStamp({ artifact, contentTick: 0 }) + '/Shot_ 1_2.png'
      )
    ).toBe(true)
    expect(uri).toBe(`file:///${requests[0].path}`)
  })

  it('reuses a downloaded copy until the content changes, then drops the old one', async () => {
    const { store, requests, files } = memoryStore()
    await downloadArtifactFile(home, { artifact, contentTick: 0 }, store)
    await downloadArtifactFile(home, { artifact, contentTick: 0 }, store)
    expect(requests).toHaveLength(1)
    await downloadArtifactFile(home, { artifact, contentTick: 1 }, store)
    expect(requests).toHaveLength(2)
    expect(files.size).toBe(1)
  })

  it('falls back to the current version when the working copy is missing', async () => {
    const { store, requests } = memoryStore((url) => (url.endsWith('/content') ? 404 : 200))
    await downloadArtifactFile(home, { artifact, contentTick: 0 }, store)
    expect(requests.map((r) => r.url)).toEqual([
      'https://home.example/api/artifacts/a1/content',
      'https://home.example/api/artifacts/a1/versions/content?ref=current'
    ])
  })

  it('downloads a version by its number', async () => {
    const { store, requests } = memoryStore()
    await downloadArtifactFile(home, { artifact, version: { ref: 3, contentHash: 'abc' } }, store)
    expect(requests[0].url).toBe('https://home.example/api/artifacts/a1/versions/content?ref=3')
  })

  it('says a refused bearer means signing in again', async () => {
    const { store } = memoryStore(() => 401)
    await expect(
      downloadArtifactFile(home, { artifact, contentTick: 0 }, store)
    ).rejects.toMatchObject({
      status: 401,
      message: 'Your sign-in to home.example has expired. Sign in again.'
    })
  })

  it('names the file and the status when the hub refuses it', async () => {
    const { store } = memoryStore(() => 500)
    await expect(
      downloadArtifactFile(home, { artifact, contentTick: 0 }, store)
    ).rejects.toMatchObject({
      status: 500,
      message: "Couldn't download Shot: 1/2.png from home.example (HTTP 500)"
    })
  })
})

describe('downloadStatusOf', () => {
  it("reads the status out of expo-file-system's download error", () => {
    expect(downloadStatusOf(new Error('Unable to download a file: response has status 404'))).toBe(
      404
    )
    expect(
      downloadStatusOf(
        new Error('Unable to download a file: The Internet connection appears to be offline.')
      )
    ).toBeNull()
  })
})

describe('forgetArtifactCache', () => {
  it("deletes one hub's files and keeps the others'", async () => {
    const work = hubTarget({ entry: hubEntryOf('work.example'), token: 'w' })
    const { store, files } = memoryStore()
    await downloadArtifactFile(home, { artifact, contentTick: 0 }, store)
    await downloadArtifactFile(work, { artifact, contentTick: 0 }, store)
    forgetArtifactCache(home.hubId, store)
    expect([...files.keys()].every((p) => p.includes('work.example'))).toBe(true)
    expect(files.size).toBe(1)
  })
})
