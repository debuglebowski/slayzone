import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { openComputerChatRuntime, type OnlineComputerChatRuntime } from './computer-online-runtime'
import type { ArtifactPublicationClient } from './artifact-publication-client'
import type {
  PublicationContext,
  PublicationSourceGrant,
  PublicationSettlement
} from './artifact-publication-protocol'

const workerPath = fileURLToPath(new URL('../../../../apps/computer/dist/bin.cjs', import.meta.url))
const route = { id: 'c', epoch: 1 }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bootstrap = {
  identity: { ...route, taskId: 't', tabId: 'tab', mode: 'claude-chat' },
  projectId: null,
  cwd: '/tmp',
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
}
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'artifact-publication-'))
  const runtime = await openComputerChatRuntime({
    stateDir,
    hubScope: 'hub',
    computerId: 'pc',
    workerPath,
    blobBackfill: { automatic: false },
    markerBackfill: { automatic: false },
    compaction: { automaticReclaim: false }
  })
  await runtime.bootstrap(bootstrap)
  return {
    runtime,
    async close() {
      await runtime.close()
      await rm(stateDir, { recursive: true, force: true })
    }
  }
}
function client(runtime: OnlineComputerChatRuntime): ArtifactPublicationClient {
  const value = Reflect.get(runtime, 'artifactPublication')
  expect(value, 'actual online factory must expose its canonical publication backend').toBeDefined()
  return value
}
async function stage(
  runtime: OnlineComputerChatRuntime,
  operationId: string,
  size: number,
  seed = 7
) {
  const revision = 0,
    uploadId = digest(['t', route, operationId, revision])
  const path = join(
    runtime.storage.dir,
    'uploads',
    'owned',
    digest('t'),
    digest(route.id),
    uploadId,
    'data.part'
  )
  await mkdir(dirname(path), { recursive: true })
  const file = await open(path, 'wx', 0o600),
    hash = createHash('sha256')
  const block = Buffer.alloc(256 * 1024)
  for (let i = 0; i < block.length; i++) block[i] = (i * 17 + seed) % 256
  try {
    for (let offset = 0; offset < size; ) {
      const bytes = block.subarray(0, Math.min(block.length, size - offset))
      await file.writeFile(bytes)
      hash.update(bytes)
      offset += bytes.length
    }
    await file.sync()
  } finally {
    await file.close()
  }
  const ref = { sha256: hash.digest('hex'), size, uploadId }
  await writeFile(
    join(dirname(path), 'manifest.json'),
    JSON.stringify({ version: 1, taskId: 't', route, operationId, revision, ...ref })
  )
  const info = await lstat(path, { bigint: true })
  const grant: PublicationSourceGrant = {
    kind: 'staged-path',
    leaseId: digest([operationId, 'lease']),
    entryId: digest([operationId, 'entry']),
    path,
    ref,
    identity: { dev: String(info.dev), ino: String(info.ino), size },
    binding: { kind: 'owned', taskId: 't', route, operationId, revision }
  }
  const reserve = vi.fn(async (_ref: typeof ref, _context: PublicationContext) => ({
    grant,
    assertCurrent() {},
    release: vi.fn(async (consumed: boolean) => {
      if (consumed) await rm(path)
    })
  }))
  return { grant, ref, uploads: { reserveForPublication: reserve }, reserve }
}
async function hashFile(path: string) {
  const hash = createHash('sha256')
  let size = 0
  for await (const bytes of createReadStream(path)) {
    hash.update(bytes)
    size += bytes.length
  }
  return { sha256: hash.digest('hex'), size }
}

test('canonical staged upload is bounded, durable, byte exact and replays after source consumption', async () => {
  const f = await fixture()
  try {
    const source = await stage(f.runtime, 'large', 32 * 1024 * 1024 + 17)
    const publication = client(f.runtime)
    const post = vi.spyOn(f.runtime.storage.db, 'namedTxn')
    const request = {
      route,
      operationId: 'large',
      intent: {
        method: 'uploadArtifactBlob' as const,
        args: [{ taskId: 't', title: 'binary.bin', staged: source.ref }] as [
          { taskId: string; title: string; staged: typeof source.ref }
        ]
      }
    }
    const execution = publication.start(request, source.uploads)
    const value = await execution.result
    await execution.quiesced
    expect(value.outcome, JSON.stringify(value.outcome)).toMatchObject({
      kind: 'committed',
      durability: 'owner-flush',
      replayed: false
    })
    if (value.outcome.kind !== 'committed' || value.outcome.value.method !== 'uploadArtifactBlob')
      throw new Error('upload did not commit')
    const artifact = value.outcome.value.result!
    expect(
      await hashFile(join(f.runtime.storage.dir, 'artifacts', 't', `${artifact.id}.bin`))
    ).toEqual({ sha256: source.ref.sha256, size: source.ref.size })
    const calls = post.mock.calls.filter(
      ([name, params]) =>
        name === 'chatRuntime.call' &&
        (params as { group?: string }).group === 'artifactPublication'
    )
    expect(calls.some(([, p]) => (p as { method?: string }).method === 'publish')).toBe(true)
    for (const [, payload] of calls) expect(JSON.stringify(payload).length).toBeLessThan(16 * 1024)
    const replay = await publication.start(request, source.uploads).result
    expect(replay.outcome).toMatchObject({
      kind: 'committed',
      replayed: true,
      value: value.outcome.value
    })
    expect(source.reserve).toHaveBeenCalledTimes(1)
    const versions = await f.runtime.artifacts.invoke({
      route,
      method: 'listArtifactVersions',
      args: [{ artifactId: artifact.id }]
    })
    expect(versions).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('overlapping staged appends serialize their complete before-image lifetime and preserve undo versions', async () => {
  const f = await fixture()
  try {
    const publication = client(f.runtime),
      source = await stage(f.runtime, 'seed', 4 * 1024 * 1024)
    const initial = await publication.start(
      {
        route,
        operationId: 'seed',
        intent: {
          method: 'uploadArtifactBlob',
          args: [{ taskId: 't', title: 'append.bin', staged: source.ref }]
        }
      },
      source.uploads
    ).result
    if (
      initial.outcome.kind !== 'committed' ||
      initial.outcome.value.method !== 'uploadArtifactBlob'
    )
      throw new Error('seed failed: ' + JSON.stringify(initial.outcome))
    const artifactId = initial.outcome.value.result!.id
    const left = await stage(f.runtime, 'left', 256 * 1024 + 1, 13),
      right = await stage(f.runtime, 'right', 256 * 1024 - 1, 19)
    const expected = createHash('sha256')
    for (const path of [
      join(f.runtime.storage.dir, 'artifacts', 't', `${artifactId}.bin`),
      left.grant.path,
      right.grant.path
    ])
      for await (const bytes of createReadStream(path)) expected.update(bytes)
    const jobs = [left, right].map((s, index) =>
      publication.start(
        {
          route,
          operationId: index ? 'right' : 'left',
          intent: {
            method: 'writeArtifactContent',
            args: [{ artifactId, staged: s.ref, append: true }]
          }
        },
        s.uploads
      )
    )
    const results = await Promise.all(jobs.map((job) => job.result))
    expect(results.map((s) => s.outcome.kind)).toEqual(['committed', 'committed'])
    expect(
      await hashFile(join(f.runtime.storage.dir, 'artifacts', 't', `${artifactId}.bin`))
    ).toEqual({
      sha256: expected.digest('hex'),
      size: 4 * 1024 * 1024 + left.ref.size + right.ref.size
    })
    expect(
      await f.runtime.artifacts.invoke({
        route,
        method: 'listArtifactVersions',
        args: [{ artifactId }]
      })
    ).toHaveLength(3)
    await f.runtime.artifacts.invoke({
      route,
      method: 'setCurrentArtifactVersion',
      operationId: 'undo',
      args: [{ artifactId, versionRef: 1 }]
    })
    expect(
      await hashFile(join(f.runtime.storage.dir, 'artifacts', 't', `${artifactId}.bin`))
    ).toEqual({ sha256: source.ref.sha256, size: source.ref.size })
  } finally {
    await f.close()
  }
})

test('forged private source paths fail before acceptance and the same operation can retry with its exact grant', async () => {
  const f = await fixture()
  try {
    const publication = client(f.runtime),
      source = await stage(f.runtime, 'identity', 1)
    const request = {
      route,
      operationId: 'identity',
      intent: {
        method: 'uploadArtifactBlob' as const,
        args: [{ taskId: 't', title: 'identity.bin', staged: source.ref }] as [
          { taskId: string; title: string; staged: typeof source.ref }
        ]
      }
    }
    const original = source.grant.path
    source.grant.path = join(dirname(original), '..', 'foreign.part')
    const failed = await publication.start(request, source.uploads).result
    expect(failed.outcome).toMatchObject({ kind: 'not-committed', receipt: 'absent' })
    expect(await f.runtime.storage.receipt('c', 'identity')).toBeNull()
    source.grant.path = original
    expect((await publication.start(request, source.uploads).result).outcome.kind).toBe('committed')
  } finally {
    await f.close()
  }
})

test('close retains an accepted source reservation until its actual completion and releases it once', async () => {
  const f = await fixture()
  let release!: () => void
  try {
    const publication = client(f.runtime),
      source = await stage(f.runtime, 'closing', 0)
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = source.reserve.getMockImplementation()!
    source.reserve.mockImplementation(async (...args) => {
      await gate
      return held(...args)
    })
    const job = publication.start(
      {
        route,
        operationId: 'closing',
        intent: {
          method: 'uploadArtifactBlob',
          args: [{ taskId: 't', title: 'empty.bin', staged: source.ref }]
        }
      },
      source.uploads
    )
    await vi.waitFor(() => expect(source.reserve).toHaveBeenCalledTimes(1))
    let closed = false
    const closing = f.runtime.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(closed).toBe(false)
    release()
    const settlement = await job.result
    expect(settlement.outcome.kind).toBe('not-committed')
    await closing
    const lease = await source.reserve.mock.results[0].value
    expect(lease.release).toHaveBeenCalledExactlyOnceWith(false)
  } finally {
    release?.()
    await f.close()
  }
})

test('metadata rollback leaves accepted receipt unconfirmed and removes its unreferenced prepared blob', async () => {
  const f = await fixture()
  try {
    const publication = client(f.runtime),
      source = await stage(f.runtime, 'rollback', 256 * 1024 + 1)
    await f.runtime.storage.db.exec(
      "CREATE TRIGGER refuse_publication BEFORE INSERT ON task_artifacts BEGIN SELECT RAISE(ABORT,'publication metadata failure'); END"
    )
    const settlement = await publication.start(
      {
        route,
        operationId: 'rollback',
        intent: {
          method: 'uploadArtifactBlob',
          args: [{ taskId: 't', title: 'rollback.bin', staged: source.ref }]
        }
      },
      source.uploads
    ).result
    expect(settlement.outcome).toMatchObject({
      kind: 'not-committed',
      receipt: 'accepted-unconfirmed',
      error: { message: 'publication metadata failure' }
    })
    expect(await f.runtime.storage.receipt('c', 'rollback')).toMatchObject({ state: 'accepted' })
    await expect(
      lstat(
        join(
          f.runtime.storage.dir,
          'blobs',
          source.ref.sha256.slice(0, 2),
          source.ref.sha256.slice(2)
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      publication.start(
        {
          route,
          operationId: 'rollback',
          intent: {
            method: 'uploadArtifactBlob',
            args: [{ taskId: 't', title: 'rollback.bin', staged: source.ref }]
          }
        },
        source.uploads
      ).result
    ).rejects.toThrow(/unconfirmed/)
    expect(source.reserve).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
  }
})

test('unknown preparing residue remains an erasure refusal after journal recovery quarantines it', async () => {
  const f = await fixture()
  try {
    const journal = join(
      f.runtime.storage.dir,
      'artifacts',
      '.transactions',
      '00000000-0000-4000-8000-000000000001'
    )
    await mkdir(journal, { recursive: true })
    await writeFile(join(journal, 'after'), 'unknown private body')
    await f.runtime.artifacts.invoke({
      route,
      operationId: 'recover-unknown',
      method: 'uploadArtifactBlob',
      args: [{ taskId: 't', title: 'recovery.bin', data: '' }]
    })
    await expect(f.runtime.eraseTask('t', 1)).rejects.toThrow(/[Uu]nattributed|[Oo]wnership/)
  } finally {
    await f.close()
  }
})

test('private inline publication preserves binary, dedup, mutable/locked and historical version semantics', async () => {
  const f = await fixture()
  try {
    const p = client(f.runtime),
      bytes = Buffer.from([0, 255, 13, 10, 0xc3, 0x28])
    const inline = {
      route,
      operationId: 'inline',
      intent: {
        method: 'uploadArtifactBlob' as const,
        args: [{ taskId: 't', title: 'parity.bin', data: bytes.toString('base64') }] as [
          { taskId: string; title: string; data: string }
        ]
      }
    }
    const initial = await p.start(inline).result
    expect(inline.intent.args[0].data).toBe(bytes.toString('base64'))
    expect((await p.start(inline).result).outcome).toMatchObject({
      kind: 'committed',
      replayed: true
    })
    if (
      initial.outcome.kind !== 'committed' ||
      initial.outcome.value.method !== 'uploadArtifactBlob'
    )
      throw new Error(JSON.stringify(initial.outcome))
    const artifact = initial.outcome.value.result!,
      artifactId = artifact.id
    const write = async (
      operationId: string,
      data: string,
      flags: {
        mutateCurrent?: boolean
        mutateRef?: number
        author?: { type: 'agent'; id: string }
      } = {}
    ) => {
      const result = await p.start({
        route,
        operationId,
        intent: {
          method: 'writeArtifactContent',
          args: [{ artifactId, data: Buffer.from(data).toString('base64'), ...flags }]
        }
      }).result
      if (
        result.outcome.kind !== 'committed' ||
        result.outcome.value.method !== 'writeArtifactContent'
      )
        throw new Error(JSON.stringify(result.outcome))
      return result.outcome.value.result.version
    }
    const same = await p.start({
      route,
      operationId: 'unchanged',
      intent: {
        method: 'writeArtifactContent',
        args: [{ artifactId, data: bytes.toString('base64') }]
      }
    }).result
    expect(same.outcome.kind).toBe('committed')
    expect(
      await f.runtime.artifacts.invoke({
        route,
        method: 'listArtifactVersions',
        args: [{ artifactId }]
      })
    ).toHaveLength(1)
    const mutable = await write('mutable', 'tip', {
      mutateCurrent: true,
      author: { type: 'agent', id: 'unchanged-author' }
    })
    expect(mutable.version_num).toBe(1)
    expect(mutable.author_type).toBe('user')
    await f.runtime.artifacts.invoke({
      route,
      method: 'renameArtifactVersion',
      operationId: 'name',
      args: [{ artifactId, versionRef: 1, newName: 'saved' }]
    })
    const author = { type: 'agent' as const, id: 'valid-long-author:'.repeat(1500) }
    const branched = await write('branch', 'current', { mutateCurrent: true, author })
    expect(branched.version_num).toBe(2)
    expect(branched.parent_id).toBe(mutable.id)
    expect(branched.author_id).toBe(author.id)
    const historical = await write('historical', 'history', { mutateRef: 1, mutateCurrent: true })
    expect(historical.id).toBe(mutable.id)
    expect(
      await hashFile(join(f.runtime.storage.dir, 'artifacts', 't', `${artifactId}.bin`))
    ).toEqual({ sha256: createHash('sha256').update('current').digest('hex'), size: 7 })
    await rm(join(f.runtime.storage.dir, 'artifacts', 't', `${artifactId}.bin`))
    const appended = await p.start({
      route,
      operationId: 'missing-append',
      intent: {
        method: 'writeArtifactContent',
        args: [{ artifactId, data: Buffer.from('new').toString('base64'), append: true }]
      }
    }).result
    expect(appended.outcome.kind).toBe('committed')
    expect(
      await hashFile(join(f.runtime.storage.dir, 'artifacts', 't', `${artifactId}.bin`))
    ).toEqual({ sha256: createHash('sha256').update('new').digest('hex'), size: 3 })
    const empty = await p.start({
      route,
      operationId: 'empty',
      intent: {
        method: 'uploadArtifactBlob',
        args: [{ taskId: 't', title: 'parity.bin', data: '' }]
      }
    }).result
    expect(empty.outcome.kind).toBe('committed')
    if (empty.outcome.kind === 'committed' && empty.outcome.value.method === 'uploadArtifactBlob')
      expect(empty.outcome.value.result!.title).not.toBe(artifact.title)
  } finally {
    await f.close()
  }
})

test('stale physical owner context and replaced source identity reject without accepting a receipt', async () => {
  const f = await fixture()
  try {
    const p = client(f.runtime),
      source = await stage(f.runtime, 'stale', 1)
    const request = {
      route,
      operationId: 'stale',
      intent: {
        method: 'uploadArtifactBlob' as const,
        args: [{ taskId: 't', title: 'stale.bin', staged: source.ref }] as [
          { taskId: string; title: string; staged: typeof source.ref }
        ]
      }
    }
    const inspection = await p.inspect(request)
    if (inspection.kind !== 'admit') throw new Error('expected admission')
    const stale = (await f.runtime.storage.db.namedTxn('chatRuntime.call', {
      group: 'artifactPublication',
      method: 'publish',
      args: [
        {
          executionId: randomUUID(),
          context: {
            ...inspection.context,
            owner: { ...inspection.context.owner, instanceId: randomUUID() }
          },
          intent: request.intent,
          source: source.grant
        }
      ]
    })) as PublicationSettlement
    expect(stale.outcome).toMatchObject({ kind: 'not-committed', receipt: 'absent' })
    expect(await f.runtime.storage.receipt('c', 'stale')).toBeNull()
    const original = source.reserve.getMockImplementation()!
    source.reserve.mockImplementation(async (...args) => {
      const lease = await original(...args)
      await rm(source.grant.path)
      await writeFile(source.grant.path, Buffer.from([7]))
      return lease
    })
    expect((await p.start(request, source.uploads).result).outcome).toMatchObject({
      kind: 'not-committed',
      receipt: 'absent'
    })
    expect(await f.runtime.storage.receipt('c', 'stale')).toBeNull()
  } finally {
    await f.close()
  }
})

test('private version errors retain the existing public version-ref error message', async () => {
  const f = await fixture()
  try {
    const p = client(f.runtime)
    const initial = await p.start({
      route,
      operationId: 'error-seed',
      intent: {
        method: 'uploadArtifactBlob',
        args: [{ taskId: 't', title: 'errors.bin', data: '' }]
      }
    }).result
    if (
      initial.outcome.kind !== 'committed' ||
      initial.outcome.value.method !== 'uploadArtifactBlob'
    )
      throw new Error('seed failed')
    const args = [
      { artifactId: initial.outcome.value.result!.id, data: '', mutateRef: 'missing-name' }
    ] as [{ artifactId: string; data: string; mutateRef: string }]
    const legacy = await f.runtime.artifacts
      .invoke({ route, operationId: 'legacy-error', method: 'writeArtifactContent', args })
      .then(
        () => {
          throw new Error('expected invalid ref')
        },
        (error: Error) => error.message
      )
    const result = await p.start({
      route,
      operationId: 'private-error',
      intent: { method: 'writeArtifactContent', args }
    }).result
    expect(result.outcome.kind).toBe('not-committed')
    if (result.outcome.kind === 'not-committed') expect(result.outcome.error.message).toBe(legacy)
  } finally {
    await f.close()
  }
})

test('same-operation callers share one exact lease; abort detaches one interested waiter', async () => {
  const f = await fixture()
  let release!: () => void
  try {
    const p = client(f.runtime),
      source = await stage(f.runtime, 'joined', 256 * 1024 + 1)
    const reserve = source.reserve.getMockImplementation()!
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    source.reserve.mockImplementation(async (...args) => {
      await gate
      return reserve(...args)
    })
    const request = {
      route,
      operationId: 'joined',
      intent: {
        method: 'uploadArtifactBlob' as const,
        args: [{ taskId: 't', title: 'joined.bin', staged: source.ref }] as [
          { taskId: string; title: string; staged: typeof source.ref }
        ]
      }
    }
    const first = p.start(request, source.uploads)
    await vi.waitFor(() => expect(source.reserve).toHaveBeenCalledTimes(1))
    const second = p.start(request, source.uploads)
    expect(second.executionId).toBe(first.executionId)
    expect(() =>
      p.start(
        {
          ...request,
          intent: {
            method: 'uploadArtifactBlob',
            args: [{ taskId: 't', title: 'changed.bin', staged: source.ref }]
          }
        },
        source.uploads
      )
    ).toThrow(/reused/)
    const detached = first.cancel('request-aborted')
    release()
    const [one, two] = await Promise.all([detached, second.result])
    expect(one.outcome).toMatchObject({ kind: 'committed' })
    expect(two).toEqual(one)
    expect(source.reserve).toHaveBeenCalledTimes(1)
    const lease = await source.reserve.mock.results[0].value
    expect(lease.release).toHaveBeenCalledExactlyOnceWith(true)
  } finally {
    release?.()
    await f.close()
  }
})
