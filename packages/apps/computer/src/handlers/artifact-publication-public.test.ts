import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { createFixtureChatRuntime } from '../project-scope.fixture'

const route = { id: 'publication-conversation', epoch: 1 }
const opened: Array<{ close(): Promise<void> }> = []
const directories: string[] = []
afterEach(async () => {
  try {
    for (const runtime of opened.splice(0)) await runtime.close()
  } finally {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true })
  }
})

async function fixture(selectedRoute = route, tabId = 'tab') {
  const stateDir = await mkdtemp(join(tmpdir(), 'public-publication-'))
  directories.push(stateDir)
  const h = createFixtureChatRuntime({
    stateDir,
    hubScope: 'hub',
    computerId: () => 'computer',
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: 'test',
        allowedRoots: [stateDir],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  })
  opened.push(h)
  await h.request({
    kind: 'bootstrap',
    value: {
      identity: { ...selectedRoute, taskId: 't', tabId, mode: 'claude-chat' },
      projectId: null,
      cwd: stateDir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    }
  })
  const invoke = (method: string, args: unknown[], operationId?: string) =>
    h.request({
      kind: 'artifact.invoke',
      value: { route: selectedRoute, method, args, operationId }
    })
  const stage = async (operationId: string, size: number, seed: number) => {
    const block = Buffer.alloc(BYTE_RANGE_MAX_CHUNK)
    for (let i = 0; i < block.length; i++) block[i] = (i * 31 + seed) & 255
    const hash = createHash('sha256')
    for (let at = 0; at < size; at += block.length)
      hash.update(block.subarray(0, Math.min(block.length, size - at)))
    const sha256 = hash.digest('hex')
    const begun = (await h.request({
      kind: 'upload.begin',
      route: selectedRoute,
      operationId,
      sha256,
      size
    })) as {
      received: number
      uploadId: string
    }
    expect(begun.uploadId).toMatch(/^[a-f0-9]{64}$/)
    for (let offset = begun.received; offset < size; offset += block.length)
      await h.request({
        kind: 'upload.chunk',
        route: selectedRoute,
        uploadId: begun.uploadId,
        sha256,
        size,
        offset,
        data: block.subarray(0, Math.min(block.length, size - offset)).toString('base64')
      })
    return { sha256, size, uploadId: begun.uploadId }
  }
  const hashCurrent = async (artifactId: string) => {
    const hash = createHash('sha256')
    let offset = 0,
      version: string | undefined
    for (;;) {
      const page = (await invoke('readBytesRange', [artifactId, offset, BYTE_RANGE_MAX_CHUNK])) as {
        data: string
        size: number
        version: string
      }
      expect(page.version).toBe(version ?? page.version)
      version = page.version
      const bytes = Buffer.from(page.data, 'base64')
      expect(bytes.length).toBeLessThanOrEqual(BYTE_RANGE_MAX_CHUNK)
      hash.update(bytes)
      offset += bytes.length
      if (offset === page.size) return { sha256: hash.digest('hex'), size: offset }
      expect(bytes.length).toBeGreaterThan(0)
    }
  }
  return { h, invoke, stage, hashCurrent }
}

test('actual public owned 32MiB+17 publication replays after source consumption and retains v9 downloads', async () => {
  const f = await fixture()
  const staged = await f.stage('large', 32 * 1024 * 1024 + 17, 17)
  const args = [{ taskId: 't', title: 'large.bin', staged }]
  const artifact = (await f.invoke('uploadArtifactBlob', args, 'large')) as { id: string }
  expect(await f.hashCurrent(artifact.id)).toEqual({ sha256: staged.sha256, size: staged.size })
  expect(await f.invoke('uploadArtifactBlob', args, 'large')).toEqual(artifact)
  expect(await f.invoke('listArtifactVersions', [{ artifactId: artifact.id }])).toHaveLength(1)
  await expect(
    f.invoke('uploadArtifactBlob', [{ taskId: 't', title: 'changed.bin', staged }], 'large')
  ).rejects.toThrow(/reused|input/i)
}, 30_000)

test('actual public append preserves 64MiB previous bytes, 32MiB+17 addition and undo versions', async () => {
  const f = await fixture()
  const before = await f.stage('before', 64 * 1024 * 1024, 11)
  const artifact = (await f.invoke(
    'uploadArtifactBlob',
    [{ taskId: 't', title: 'append.bin', staged: before }],
    'before'
  )) as { id: string }
  const added = await f.stage('append', 32 * 1024 * 1024 + 17, 19)
  const args = [
    { artifactId: artifact.id, staged: added, append: true, author: { type: 'user', id: 'author' } }
  ]
  const written = (await f.invoke('writeArtifactContent', args, 'append')) as {
    version: { content_hash: string; size: number }
  }
  const expected = createHash('sha256')
  for (const [size, seed] of [
    [before.size, 11],
    [added.size, 19]
  ]) {
    const block = Buffer.alloc(BYTE_RANGE_MAX_CHUNK)
    for (let i = 0; i < block.length; i++) block[i] = (i * 31 + seed) & 255
    for (let at = 0; at < size; at += block.length)
      expected.update(block.subarray(0, Math.min(block.length, size - at)))
  }
  expect(written.version).toMatchObject({
    content_hash: expected.digest('hex'),
    size: before.size + added.size
  })
  expect(await f.hashCurrent(artifact.id)).toEqual({
    sha256: written.version.content_hash,
    size: written.version.size
  })
  expect(await f.invoke('writeArtifactContent', args, 'append')).toEqual(written)
  const versions = (await f.invoke('listArtifactVersions', [
    { artifactId: artifact.id }
  ])) as Array<{ content_hash: string }>
  expect(versions).toHaveLength(2)
  expect(versions.some((v) => v.content_hash === before.sha256)).toBe(true)
}, 30_000)

test('actual public small legacy inline behavior and forged source-path rejection', async () => {
  const f = await fixture()
  const artifact = (await f.invoke(
    'uploadArtifactBlob',
    [{ taskId: 't', title: 'small.txt', data: Buffer.from('héllo\r\n').toString('base64') }],
    'small'
  )) as { id: string }
  expect(await f.invoke('readArtifactContent', [artifact.id])).toBe('héllo\r\n')
  await expect(
    f.invoke(
      'uploadArtifactBlob',
      [{ taskId: 't', title: 'forged', data: 'eA==', sourcePath: '/tmp/untrusted' }],
      'forged'
    )
  ).rejects.toThrow()
  await expect(
    f.invoke(
      'writeArtifactContent',
      [
        {
          artifactId: artifact.id,
          staged: { sha256: 'a'.repeat(64), size: 1, path: '/tmp/untrusted' }
        }
      ],
      'forged-write'
    )
  ).rejects.toThrow()
}, 30_000)

test('public staging covers byte boundaries and same-operation concurrent consume/replay', async () => {
  const f = await fixture()
  for (const size of [
    0,
    1,
    BYTE_RANGE_MAX_CHUNK - 1,
    BYTE_RANGE_MAX_CHUNK,
    BYTE_RANGE_MAX_CHUNK + 1
  ]) {
    const operation = `boundary-${size}`
    const staged = await f.stage(operation, size, 0xff)
    const args = [{ taskId: 't', title: `${operation}.bin`, staged }]
    const [one, two] = (await Promise.all([
      f.invoke('uploadArtifactBlob', args, operation),
      f.invoke('uploadArtifactBlob', args, operation)
    ])) as Array<{ id: string }>
    expect(two).toEqual(one)
    expect(await f.hashCurrent(one.id)).toEqual({ sha256: staged.sha256, size })
    expect(await f.invoke('listArtifactVersions', [{ artifactId: one.id }])).toHaveLength(1)
  }
}, 30_000)

test('public binary version edits preserve authors, locked branches, historical mutation and undo', async () => {
  const f = await fixture()
  const binary = Buffer.from([0, 255, 13, 10, 0xc3, 0x28])
  const artifact = (await f.invoke(
    'uploadArtifactBlob',
    [{ taskId: 't', title: 'versions.bin', data: binary.toString('base64') }],
    'binary'
  )) as { id: string }
  const write = async (operation: string, value: Buffer, flags = {}) => {
    const result = (await f.invoke(
      'writeArtifactContent',
      [{ artifactId: artifact.id, data: value.toString('base64'), ...flags }],
      operation
    )) as {
      version: {
        id: string
        version_num: number
        author_type: string
        author_id: string
        parent_id: string
      }
    }
    return result.version
  }
  await write('dedup', binary)
  expect(await f.invoke('listArtifactVersions', [{ artifactId: artifact.id }])).toHaveLength(1)
  const mutable = await write('mutable', Buffer.from('tip'), {
    mutateCurrent: true,
    author: { type: 'agent', id: 'ignored-on-mutate' }
  })
  expect(mutable.version_num).toBe(1)
  expect(mutable.author_type).toBe('user')
  await f.invoke(
    'renameArtifactVersion',
    [{ artifactId: artifact.id, versionRef: 1, newName: 'saved' }],
    'name'
  )
  const branched = await write('branch', binary, {
    mutateCurrent: true,
    author: { type: 'agent', id: 'writer' }
  })
  expect(branched).toMatchObject({ version_num: 2, parent_id: mutable.id, author_id: 'writer' })
  const historical = await write('history', Buffer.from('historical'), {
    mutateRef: 1,
    mutateCurrent: true
  })
  expect(historical.id).toBe(mutable.id)
  expect(await f.hashCurrent(artifact.id)).toEqual({
    sha256: createHash('sha256').update(binary).digest('hex'),
    size: binary.length
  })
  await f.invoke('setCurrentArtifactVersion', [{ artifactId: artifact.id, versionRef: 1 }], 'undo')
  expect(await f.invoke('readArtifactContent', [artifact.id])).toBe('historical')
  await f.invoke('setCurrentArtifactVersion', [{ artifactId: artifact.id, versionRef: 2 }], 'redo')
  expect(await f.hashCurrent(artifact.id)).toEqual({
    sha256: createHash('sha256').update(binary).digest('hex'),
    size: binary.length
  })
}, 30_000)

test('public maximum conversation/tab identities and title survive the private owner seam', async () => {
  const f = await fixture({ id: 'c'.repeat(500), epoch: 1 }, 'b'.repeat(500))
  const operationId = 'o'.repeat(200)
  const staged = await f.stage(operationId, BYTE_RANGE_MAX_CHUNK + 1, 31)
  const title = 'x'.repeat(508) + '.bin'
  const args = [{ taskId: 't', title, staged }]
  const artifact = (await f.invoke('uploadArtifactBlob', args, operationId)) as {
    id: string
    title: string
  }
  expect(artifact.title).toBe(title)
  expect(await f.hashCurrent(artifact.id)).toEqual({ sha256: staged.sha256, size: staged.size })
  expect(await f.invoke('uploadArtifactBlob', args, operationId)).toEqual(artifact)
}, 30_000)
