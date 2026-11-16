/** Backend proof only: real canonical worker; FU1 final public-invoke adapters remain separate. */
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHubRequestHandler } from './main'
import { HubToComputerMethods as M } from '@slayzone/computer-transport/shared'
import {
  openComputerChatRuntime,
  type OnlineComputerChatRuntime,
  type InspectPublication,
  type PublicationContext,
  type PublicationControl,
  type PublicationSettlement,
  type PublicationSourceGrant
} from '@slayzone/chat-runtime/server'

const [root, extension, workerPath, mode] = process.argv.slice(2)
const probe = Reflect.get(globalThis, '__fu2PublicationProbe') as Int32Array
const observed = new Map<string, OnlineComputerChatRuntime>()
Reflect.set(globalThis, '__fu2PublicationRuntimes', observed)
const counter = new Database(':memory:')
counter.loadExtension(extension)
Reflect.set(globalThis, '__fu2PublicationExtension', extension)
assert.throws(() => new Database(':memory:'), /Native SQLite constructor refused/)
const control = (sql: string) => (counter.prepare(sql).get() as { n: number }).n
const mainSyncs = control('SELECT sync_count() n')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const route = { id: 'c', epoch: 1 }
const bootstrap = {
  identity: { ...route, taskId: 't', tabId: 'tab', mode: 'claude-chat' },
  projectId: null,
  cwd: root,
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
}
const actor = { userId: 'publication-fixture', route: 'private publication native proof' }
const scoped = { ...actor, pathScope: { kind: 'task', taskId: 't', projectId: null } }
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 8000
  while (!check()) {
    assert(Date.now() < deadline, 'publication proof deadline')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
function arm(value: number) {
  probe.fill(0)
  probe[0] = value
  probe[8] = 1
}
function release() {
  Atomics.store(probe, 2, 1)
  Atomics.notify(probe, 2)
}
async function stage(
  r: OnlineComputerChatRuntime,
  operationId: string,
  size = 4 * 1024 * 1024,
  seed = 0xa7
) {
  probe[8] = 0 // Fixture creation precedes final-invoke instrumentation.
  const uploadId = digest(['t', route, operationId, 0])
  const path = join(
    r.storage.dir,
    'uploads',
    'owned',
    digest('t'),
    digest('c'),
    uploadId,
    'data.part'
  )
  await mkdir(dirname(path), { recursive: true })
  const file = await open(path, 'wx', 0o600),
    hash = createHash('sha256'),
    block = Buffer.alloc(256 * 1024, seed)
  try {
    for (let at = 0; at < size; ) {
      const bytes = block.subarray(0, Math.min(block.length, size - at))
      await file.writeFile(bytes)
      hash.update(bytes)
      at += bytes.length
    }
    await file.sync()
  } finally {
    await file.close()
  }
  const ref = { sha256: hash.digest('hex'), size, uploadId }
  await writeFile(
    join(dirname(path), 'manifest.json'),
    JSON.stringify({ version: 1, taskId: 't', route, operationId, revision: 0, ...ref })
  )
  const stat = await lstat(path, { bigint: true })
  const grant: PublicationSourceGrant = {
    kind: 'staged-path',
    leaseId: digest([operationId, 'lease']),
    entryId: digest([operationId, 'entry']),
    path,
    ref,
    identity: { dev: String(stat.dev), ino: String(stat.ino), size },
    binding: { kind: 'owned', taskId: 't', route, operationId, revision: 0 }
  }
  let releases = 0,
    consumed = false
  let assertRelease: () => void = () => undefined
  return {
    grant,
    operationId,
    request: {
      route,
      operationId,
      intent: {
        method: 'uploadArtifactBlob' as const,
        args: [{ taskId: 't', title: `${operationId}.bin`, staged: ref }] as [
          { taskId: string; title: string; staged: typeof ref }
        ]
      }
    },
    uploads: {
      async reserveForPublication(_ref: unknown, _context: PublicationContext) {
        return {
          grant,
          assertCurrent() {
            /* Fixture reservation remains current until explicit faults. */
          },
          async release(success: boolean) {
            assertRelease()
            releases++
            consumed = success
            if (success) await rm(grant.path)
          }
        }
      }
    },
    released: () => releases,
    consumed: () => consumed,
    onRelease(check: () => void) {
      assertRelease = check
    }
  }
}
async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
const options = (hubScope: string) => ({
  stateDir: root,
  hubScope,
  computerId: 'pc',
  workerPath,
  blobBackfill: { automatic: false },
  markerBackfill: { automatic: false },
  compaction: { automaticReclaim: false }
})
async function direct(scope: string) {
  const r = await openComputerChatRuntime(options(scope))
  await r.bootstrap(bootstrap)
  return r
}
async function residue(r: OnlineComputerChatRuntime) {
  try {
    return await readdir(join(r.storage.dir, 'artifacts', '.transactions'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
const live: OnlineComputerChatRuntime[] = []
async function cachePressure() {
  const r = await direct(`publication-${mode}`)
  live.push(r)
  const metrics = Reflect.get(globalThis, '__fu2PublicationCacheProbe') as Int32Array
  const inline = Buffer.alloc(48 * 1024, 0x71).toString('base64')
  const seed: InspectPublication = {
    route,
    operationId: 'cache-seed',
    intent: {
      method: 'uploadArtifactBlob',
      args: [{ taskId: 't', title: 'cache.bin', data: inline }]
    }
  }
  const first = await r.artifactPublication.start(seed).result
  assert.equal(first.outcome.kind, 'committed')
  const retired = () => {
    assert(metrics[0] > 0 && metrics[1] >= inline.length, 'real inline jobs observed')
    assert.equal(metrics[6], 0, 'completed Job.request must be retired')
    assert.equal(metrics[7], 0, 'completed inline body must be cleared')
    assert.equal(metrics[5], metrics[0], 'every completed job retired its body/request')
    assert(metrics[8] <= 256, 'completed observation count bound')
    assert(metrics[9] <= 1024 * 1024, 'completed observation serialized character budget')
    assert.equal(metrics[4], metrics[2], 'eviction removes all completed execution aliases')
  }
  retired() // The isolated cache-negative mode must fail this exact positive assertion.
  if (first.outcome.kind !== 'committed' || first.outcome.value.method !== 'uploadArtifactBlob')
    throw new Error('cache seed failed')
  const artifact = first.outcome.value.result!
  const controlOf = (settled: PublicationSettlement): PublicationControl => ({
    owner: settled.owner,
    key: settled.key,
    executionId: settled.executionId
  })
  const matched = async (settled: PublicationSettlement) => {
    assert.deepEqual(await r.storage.publicationControl('status', controlOf(settled)), settled)
    assert.deepEqual(
      await r.storage.publicationControl('cancel', { ...controlOf(settled), reason: 'shutdown' }),
      settled
    )
  }
  await matched(first)
  let request = seed,
    oldest = first,
    newest = first
  if (mode === 'cache-budget') {
    request = {
      route,
      operationId: 'cache-author',
      intent: {
        method: 'writeArtifactContent',
        args: [
          {
            artifactId: artifact.id,
            data: Buffer.alloc(48 * 1024, 0x72).toString('base64'),
            author: { type: 'agent', id: 'a'.repeat(80 * 1024) }
          }
        ]
      }
    }
    oldest = newest = await r.artifactPublication.start(request).result
    assert.equal(newest.outcome.kind, 'committed')
    if (
      newest.outcome.kind === 'committed' &&
      newest.outcome.value.method === 'writeArtifactContent'
    )
      assert.equal(newest.outcome.value.result.version.author_id?.length, 80 * 1024)
  }
  const inspection = await r.artifactPublication.inspect(request)
  const callerData = request.intent.args[0].data
  assert.equal(inspection.kind, 'replay')
  if (inspection.kind !== 'replay') throw new Error('cache receipt missing')
  const post = r.storage.db.namedTxn.bind(r.storage.db) as (
    name: string,
    args: unknown
  ) => Promise<unknown>
  // Real duplicate deliveries hit receipt replay and the real FULL fence. They populate
  // the production execution cache without hundreds of file creations or large bodies.
  const count = mode === 'cache-count' ? 257 : 16
  for (let i = 0; i < count; i++) {
    newest = (await post('chatRuntime.call', {
      group: 'artifactPublication',
      method: 'publish',
      args: [{ executionId: randomUUID(), context: inspection.context, intent: request.intent }]
    })) as PublicationSettlement
    assert.equal(newest.outcome.kind, 'committed')
    if (newest.outcome.kind === 'committed') assert.equal(newest.outcome.replayed, true)
  }
  retired()
  assert.equal((await r.storage.publicationControl('status', controlOf(oldest))).kind, 'absent')
  await assert.rejects(
    r.storage.publicationControl('cancel', { ...controlOf(oldest), reason: 'shutdown' }),
    /Unknown artifact publication execution/
  )
  await matched(newest)
  if (mode === 'cache-count') assert.equal(metrics[2], 256)
  else assert(metrics[2] > 1 && metrics[2] < 16, 'character pressure prunes well before count cap')
  const replay = await r.artifactPublication.start(request).result
  assert.equal(replay.outcome.kind, 'committed')
  if (replay.outcome.kind === 'committed') assert.equal(replay.outcome.replayed, true)
  assert.equal(request.intent.args[0].data, callerData, 'caller inline input remains unchanged')

  // A fresh staged job still has positive physical settlement/lease controls after pruning.
  const source = await stage(r, 'cache-staged', 64 * 1024)
  arm(1)
  const running = r.artifactPublication.start(source.request, source.uploads)
  await until(() => !!probe[1])
  const runningControl = {
    owner: newest.owner,
    key: { conversationId: route.id, operationId: source.operationId },
    executionId: running.executionId
  }
  assert.equal((await r.storage.publicationControl('status', runningControl)).kind, 'running')
  assert(probe[12] > 0, 'actual body descriptors remain live')
  assert.equal(source.released(), 0)
  release()
  const staged = await running.result
  await matched(staged)
  assert.equal(source.released(), 1)
  assert.equal(source.consumed(), true)
  assert.equal(probe[12], 0)
  const stagedReplay = await r.artifactPublication.start(source.request, source.uploads).result
  assert.equal(stagedReplay.outcome.kind, 'committed')
  if (stagedReplay.outcome.kind === 'committed') assert.equal(stagedReplay.outcome.replayed, true)
  assert.equal(source.released(), 1, 'receipt replay needs no consumed source lease')
  retired()

  if (mode === 'cache-budget') {
    // One valid large author makes the settlement itself exceed the cache budget.
    // Drop that successful reply: absent status/cancel cannot release its posted source.
    const lost = await stage(r, 'cache-evicted-reply', 64 * 1024)
    const lostRequest: InspectPublication = {
      route,
      operationId: lost.operationId,
      intent: {
        method: 'writeArtifactContent',
        args: [
          {
            artifactId: artifact.id,
            staged: lost.grant.ref,
            author: { type: 'agent', id: 'z'.repeat(1024 * 1024) }
          }
        ]
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(r.storage.db, 'namedTxn')
    const terminateDescriptor = Object.getOwnPropertyDescriptor(r.storage, 'terminate')
    const terminate = r.storage.terminate.bind(r.storage)
    let terminationRequested = false,
      absentObserved = false,
      exited = false,
      finished = false,
      quiescent = false
    void r.storage.exited.then(() => {
      exited = true
    })
    lost.onRelease(() => assert.equal(exited, true, 'absent is not physical owner exit'))
    r.storage.db.namedTxn = (async (name: string, args: unknown) => {
      const result = await post(name, args)
      if (name === 'chatRuntime.call' && (args as { method?: string }).method === 'publish') {
        const settled = result as PublicationSettlement
        assert.equal(settled.outcome.kind, 'committed')
        assert.equal(
          (await r.storage.publicationControl('status', controlOf(settled))).kind,
          'absent'
        )
        absentObserved = true
        throw new Error('lost successful self-evicted reply')
      }
      return result
    }) as typeof r.storage.db.namedTxn
    // A resolved cleanup request is deliberately weaker than actual owner exit.
    r.storage.terminate = async () => {
      terminationRequested = true
    }
    const job = r.artifactPublication.start(lostRequest, lost.uploads)
    void job.result.then(
      () => {
        finished = true
      },
      () => {
        finished = true
      }
    )
    void job.quiesced.then(() => {
      quiescent = true
    })
    try {
      await until(() => terminationRequested)
      assert.equal(absentObserved, true)
      retired()
      assert.equal(metrics[2], 0, 'oversized settlement cannot remain cached')
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(exited, false)
      assert.equal(finished, false)
      assert.equal(quiescent, false)
      assert.equal(lost.released(), 0)
      const terminating = terminate()
      await assert.rejects(job.result, /physical owner exited/)
      await terminating
      await job.quiesced
      assert.equal(exited, true)
      assert.equal(lost.released(), 1)
      assert.equal(lost.consumed(), false)
      assert(existsSync(lost.grant.path))
    } finally {
      if (descriptor) Object.defineProperty(r.storage.db, 'namedTxn', descriptor)
      else Reflect.deleteProperty(r.storage.db, 'namedTxn')
      if (terminateDescriptor) Object.defineProperty(r.storage, 'terminate', terminateDescriptor)
      else Reflect.deleteProperty(r.storage, 'terminate')
      if (!exited) await terminate().catch(() => undefined)
    }
    const fresh = await direct(`publication-${mode}`)
    live.push(fresh)
    const recovered = await fresh.artifactPublication.start(lostRequest, lost.uploads).result
    assert.equal(recovered.outcome.kind, 'committed')
    if (
      recovered.outcome.kind === 'committed' &&
      recovered.outcome.value.method === 'writeArtifactContent'
    ) {
      assert.equal(recovered.outcome.replayed, true)
      assert.equal(recovered.outcome.value.result.version.author_id?.length, 1024 * 1024)
    }
    assert.equal(lost.released(), 1)
  }
  console.log(
    JSON.stringify({
      mode,
      actualPackagedWorker: true,
      retiredRequestsAndBodies: true,
      completedCountBound: true,
      completedCharacterBudget: true,
      matchedStatusCancelAfterPressure: true,
      replayAfterEviction: true,
      stagedLeaseAfterPressure: true,
      ...(mode === 'cache-budget'
        ? { absentWaitedForActualExit: true, longValidAuthorPreserved: true }
        : {}),
      observations: metrics[0],
      inlineCharactersObserved: metrics[1],
      maxCompletedCount: metrics[8],
      maxCompletedCharacters: metrics[9],
      mainSyncs: control('SELECT sync_count() n') - mainSyncs
    })
  )
}
async function relay() {
  let notifications = 0
  const r = await openComputerChatRuntime({
    ...options('publication-relay'),
    onMetadata() {
      notifications++
      throw new Error('injected metadata consumer failure')
    }
  })
  live.push(r)
  await r.bootstrap(bootstrap)
  const source = await stage(r, 'relay')
  const first = await r.artifactPublication.start(source.request, source.uploads).result
  assert.equal(first.outcome.kind, 'committed')
  assert.equal(source.released(), 1)
  assert.equal(source.consumed(), true)
  const lost = await stage(r, 'lost-reply')
  const descriptor = Object.getOwnPropertyDescriptor(r.storage.db, 'namedTxn')
  const post = r.storage.db.namedTxn as (name: string, args: unknown) => Promise<unknown>
  r.storage.db.namedTxn = (async (name: string, args: unknown) => {
    const result = await post(name, args)
    if (
      name === 'chatRuntime.call' &&
      (args as { group?: string; method?: string }).group === 'artifactPublication' &&
      (args as { method?: string }).method === 'publish'
    )
      throw new Error('injected lost successful reply')
    return result
  }) as typeof r.storage.db.namedTxn
  let result
  try {
    result = await r.artifactPublication.start(lost.request, lost.uploads).result
  } finally {
    if (descriptor) Object.defineProperty(r.storage.db, 'namedTxn', descriptor)
    else Reflect.deleteProperty(r.storage.db, 'namedTxn')
  }
  assert.equal(result.outcome.kind, 'committed')
  assert.equal(lost.released(), 1)
  assert.equal(lost.consumed(), true)
  const replay = await r.artifactPublication.start(lost.request, lost.uploads).result
  assert.equal(replay.outcome.kind, 'committed')
  if (replay.outcome.kind === 'committed') assert.equal(replay.outcome.replayed, true)
  await until(() => notifications === 2)
  const metadata = await r.local.metadataSnapshot('c')
  assert.equal(metadata.pending.length, 2)
  assert.equal(new Set(metadata.pending).size, 2)
  assert.equal(metadata.counter, 2)
  console.log(
    JSON.stringify({
      mode: 'relay',
      actualPackagedWorker: true,
      notificationFailureRetainedOutbox: true,
      lostReplyMatchedSettlement: true,
      replayWithoutConsumedSource: true,
      noDuplicateMetadata: true,
      mainSyncs: control('SELECT sync_count() n') - mainSyncs
    })
  )
}
async function faults() {
  const r = await direct('publication-faults')
  live.push(r)
  const seed = await stage(r, 'fault-seed')
  const initial = await r.artifactPublication.start(seed.request, seed.uploads).result
  if (initial.outcome.kind !== 'committed' || initial.outcome.value.method !== 'uploadArtifactBlob')
    throw new Error('fault seed failed')
  const artifact = initial.outcome.value.result!,
    working = join(r.storage.dir, 'artifacts', 't', `${artifact.id}.bin`)
  for (const phase of [6, 7, 8, 9]) {
    const source = await stage(r, `fault-${phase}`, 4 * 1024 * 1024, 0xd4)
    arm(phase)
    source.onRelease(() =>
      assert.equal(probe[12], 0, 'positive settlement requires every body descriptor closed')
    )
    const result = await r.artifactPublication.start(
      {
        route,
        operationId: `fault-${phase}`,
        intent: {
          method: 'writeArtifactContent',
          args: [{ artifactId: artifact.id, staged: source.grant.ref }]
        }
      },
      source.uploads
    ).result
    assert.equal(result.outcome.kind, 'not-committed', JSON.stringify(result.outcome))
    if (result.outcome.kind === 'not-committed') {
      assert.equal(result.outcome.error.props?.code, 'EIO')
      assert.equal(result.outcome.receipt, phase === 6 ? 'absent' : 'accepted-unconfirmed')
    }
    assert.equal(source.consumed(), false)
    assert.equal(source.released(), 1)
    assert.equal(probe[4], 0)
    assert.equal(probe[11], 0)
    probe[8] = 0
    assert.equal(await hashFile(working), seed.grant.ref.sha256)
    assert.deepEqual(await residue(r), [])
    assert.equal(
      (
        (await r.artifacts.invoke({
          route,
          method: 'listArtifactVersions',
          args: [{ artifactId: artifact.id }]
        })) as unknown[]
      ).length,
      1
    )
  }
  console.log(
    JSON.stringify({
      mode: 'faults',
      actualPackagedWorker: true,
      sourceRead: true,
      blobSync: true,
      workingSync: true,
      parentSyncRollback: true,
      allBodyDescriptorsClosed: true,
      previousVersionPreserved: true,
      mainSyncs: control('SELECT sync_count() n') - mainSyncs
    })
  )
}
async function large() {
  const r = await direct('publication-large')
  live.push(r)
  const before = await stage(r, 'large-before', 64 * 1024 * 1024)
  arm(0)
  const initial = await r.artifactPublication.start(before.request, before.uploads).result
  assert.equal(initial.outcome.kind, 'committed')
  if (initial.outcome.kind !== 'committed' || initial.outcome.value.method !== 'uploadArtifactBlob')
    throw new Error('large seed failed')
  const artifact = initial.outcome.value.result!
  const working = join(r.storage.dir, 'artifacts', 't', `${artifact.id}.bin`)
  const appended = await stage(r, 'large-append', 32 * 1024 * 1024 + 17)
  const expected = createHash('sha256')
  for (const path of [working, appended.grant.path])
    for await (const bytes of createReadStream(path)) expected.update(bytes)
  arm(0)
  const result = await r.artifactPublication.start(
    {
      route,
      operationId: 'large-append',
      intent: {
        method: 'writeArtifactContent',
        args: [{ artifactId: artifact.id, append: true, staged: appended.grant.ref }]
      }
    },
    appended.uploads
  ).result
  assert.equal(result.outcome.kind, 'committed')
  assert.equal(probe[4], 0)
  assert.equal(probe[11], 0)
  assert(probe[3] <= 256 * 1024)
  const maxRead = probe[3]
  probe[8] = 0
  assert.equal(await hashFile(working), expected.digest('hex'))
  const versions = await r.artifacts.invoke({
    route,
    method: 'listArtifactVersions',
    args: [{ artifactId: artifact.id }]
  })
  assert.equal((versions as unknown[]).length, 2)
  console.log(
    JSON.stringify({
      mode: 'large',
      actualPackagedWorker: true,
      previousBytes: 64 * 1024 * 1024,
      appendedBytes: appended.grant.ref.size,
      maxRead,
      wholeWorkerBodyReads: probe[4],
      mainBodyIo: probe[11],
      mainSyncs: control('SELECT sync_count() n') - mainSyncs
    })
  )
}
async function portable() {
  const r = await direct('publication-portable')
  live.push(r)
  const source = await stage(r, 'cancelled')
  arm(1)
  const job = r.artifactPublication.start(source.request, source.uploads)
  await until(() => !!probe[1])
  let quiet = false
  void job.quiesced.then(() => {
    quiet = true
  })
  const cancelled = job.cancel('request-aborted')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(quiet, false)
  assert.equal(source.released(), 0)
  release()
  assert.equal((await cancelled).outcome.kind, 'not-committed')
  assert.equal(source.released(), 1)
  assert.equal(source.consumed(), false)
  assert.deepEqual(await residue(r), [])

  const closingRuntime = await direct('publication-close-committed')
  live.push(closingRuntime)
  const closingSource = await stage(closingRuntime, 'native-pub')
  arm(4)
  const committedBeforeClose = closingRuntime.artifactPublication.start(
    closingSource.request,
    closingSource.uploads
  )
  await until(() => !!probe[1])
  let finishedClose = false
  const closePending = closingRuntime.close().then(() => {
    finishedClose = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(finishedClose, false)
  assert.equal(closingSource.released(), 0)
  release()
  assert.equal((await committedBeforeClose.result).outcome.kind, 'committed')
  await closePending
  assert.equal(closingSource.consumed(), true)
  assert.equal(closingSource.released(), 1)

  const failed = await stage(r, 'file-failed')
  arm(1)
  probe[9] = 1
  const failing = r.artifactPublication.start(failed.request, failed.uploads)
  await until(() => !!probe[1])
  release()
  const failure = (await failing.result).outcome
  assert.equal(failure.kind, 'not-committed')
  if (failure.kind === 'not-committed') assert.equal(failure.error.props?.code, 'EIO')
  assert.equal(failed.consumed(), false)

  const legacy = await stage(r, 'legacy-touch')
  const path = join(
    r.storage.dir,
    'uploads',
    `${legacy.grant.ref.sha256}-${legacy.grant.ref.size}.part`
  )
  await copyFile(legacy.grant.path, path)
  const stat = await lstat(path, { bigint: true })
  legacy.grant.path = path
  delete legacy.grant.ref.uploadId
  legacy.grant.binding = { kind: 'legacy' }
  legacy.grant.identity = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: legacy.grant.ref.size
  }
  arm(1)
  const touched = r.artifactPublication.start(legacy.request, legacy.uploads)
  await until(() => !!probe[1])
  await utimes(path, new Date(), new Date(Date.now() + 1000))
  release()
  const touchedResult = await touched.result
  assert.equal(touchedResult.outcome.kind, 'committed', JSON.stringify(touchedResult.outcome))
  assert.equal(probe[4], 0)
  assert(probe[3] <= 256 * 1024)

  for (const phase of [1, 5]) {
    const edited = await stage(r, `source-edited-${phase}`)
    arm(phase)
    const editing = r.artifactPublication.start(edited.request, edited.uploads)
    await until(() => !!probe[1])
    probe[8] = 0 // External writer fault, outside product finalization.
    const changed = await open(edited.grant.path, 'r+'),
      block = Buffer.alloc(256 * 1024, 0xd4)
    try {
      for (let at = 0; at < edited.grant.ref.size; at += block.length)
        await changed.write(block, 0, Math.min(block.length, edited.grant.ref.size - at), at)
    } finally {
      await changed.close()
    }
    probe[8] = 1
    release()
    assert.equal(
      (await editing.result).outcome.kind,
      'not-committed',
      'same-inode changed source cannot publish its old before-read hash'
    )
    assert.equal(edited.consumed(), false)
  }

  const eraseSource = await stage(r, 'erase-held')
  arm(1)
  const erasingJob = r.artifactPublication.start(eraseSource.request, eraseSource.uploads)
  await until(() => !!probe[1])
  let erased = false
  const erasing = r
    .eraseTask('t', 1, async () => {
      assert.equal(eraseSource.released(), 1)
      await rm(join(r.storage.dir, 'uploads', 'owned', digest('t')), {
        recursive: true,
        force: true
      })
    })
    .then(() => {
      erased = true
    })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(erased, false)
  assert.equal(eraseSource.released(), 0)
  release()
  await erasingJob.result
  await erasing
  assert.deepEqual(await residue(r), [])

  const dying = await direct('publication-close')
  live.push(dying)
  const closeSource = await stage(dying, 'close-failed')
  let physicallyExited = false
  void dying.storage.exited.then(() => {
    physicallyExited = true
  })
  closeSource.onRelease(() =>
    assert.equal(physicallyExited, true, 'failed close cannot release a still-live source')
  )
  arm(3)
  const closeJob = dying.artifactPublication.start(closeSource.request, closeSource.uploads)
  await assert.rejects(closeJob.result)
  await closeJob.quiesced
  assert.equal(physicallyExited, true)
  assert.equal(closeSource.released(), 1)
  assert.equal(closeSource.consumed(), false)

  for (const committed of [false, true]) {
    const scope = committed ? 'publication-after-crash' : 'publication-before-crash'
    const crashing = await direct(scope)
    live.push(crashing)
    const source = await stage(crashing, committed ? 'native-pub' : 'before-crash')
    arm(committed ? 4 : 1)
    const job = crashing.artifactPublication.start(source.request, source.uploads)
    await until(() => !!probe[1])
    let exited = false
    void crashing.storage.exited.then(() => {
      exited = true
    })
    source.onRelease(() => assert.equal(exited, true))
    const terminating = crashing.storage.terminate()
    await assert.rejects(job.result)
    await terminating
    release()
    const reopened = await direct(scope)
    live.push(reopened)
    assert.deepEqual(await residue(reopened), [])
    const replay = await reopened.artifactPublication.start(source.request, source.uploads).result
    assert.equal(replay.outcome.kind, 'committed')
    if (replay.outcome.kind === 'committed') assert.equal(replay.outcome.replayed, committed)
  }
  console.log(
    JSON.stringify({
      mode: 'portable',
      actualPackagedWorker: true,
      boundedWorkerReads: true,
      cancelledQuiescent: true,
      fileSyncFailure: true,
      legacyMtimeTouch: true,
      sameInodeSourceChangeRejected: true,
      eraseWaited: true,
      committedBeforeClosePreserved: true,
      closeFailureWaitedForExit: true,
      beforeAndAfterCommitCrashRecovery: true,
      mainSyncs: control('SELECT sync_count() n') - mainSyncs
    })
  )
}

async function native() {
  const make = (scope: string) =>
    createHubRequestHandler({
      stateDir: root,
      hubScope: scope,
      getComputerId: () => 'pc',
      shutdown() {
        /* No live-computer shutdown requested by this fixture. */
      },
      dialer: { notify: () => true },
      config: {
        hubUrl: `ws://${scope}/computers`,
        name: scope,
        allowedRoots: [root],
        capabilities: ['fs', 'proc']
      }
    })
  const a = make('publication-a'),
    b = make('publication-b')
  let reopenedA: ReturnType<typeof make> | undefined
  try {
    for (const h of [a, b]) {
      await h.handle(
        M.chatRequest,
        {
          kind: 'taskPaths',
          value: { op: 'set', taskId: 't', projectId: null, baseDir: root, at: 1 }
        },
        actor
      )
      await h.handle(M.chatRequest, { kind: 'bootstrap', value: bootstrap }, actor)
      await h.handle(
        M.procSpawn,
        {
          sessionId: 'same-id',
          spawnId: 'one',
          taskId: 't',
          command: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          cwd: root,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        scoped
      )
    }
    const r = observed.get('publication-a')!,
      other = observed.get('publication-b')!
    assert(r && other, 'observe the actual production dispatch factory, never a replacement owner')
    await other.storage.maintenance.pauseCheckpointer()
    const source = await stage(r, 'native-pub', 32 * 1024 * 1024 + 17)
    arm(4)
    const job = r.artifactPublication.start(source.request, source.uploads)
    await until(() => !!probe[1]) // Metadata committed; no durability acknowledgement yet.
    control('SELECT block_sync(1) n')
    release()
    await until(() => !!control('SELECT sync_blocked() n'))
    let acknowledged = false
    void job.result.then(() => {
      acknowledged = true
    })
    let readDone = false
    const reading = a.handle(M.fsPathExists, { path: root }, scoped).then(() => {
      readDone = true
    })
    await assert.rejects(a.handle(M.ping, {}, {}), /actor|protocol/)
    const start = Date.now()
    await a.handle(M.ping, {}, scoped)
    await b.handle(M.ping, {}, scoped)
    assert.deepEqual(await a.handle(M.procKill, { sessionId: 'same-id', spawnId: 'one' }, scoped), {
      ok: true,
      clean: true
    })
    assert(JSON.stringify(await b.handle(M.procList, {}, actor)).includes('same-id'))
    assert.equal(acknowledged, false)
    assert.equal(readDone, false)
    assert.equal(source.released(), 0)
    const controlMs = Date.now() - start
    control('SELECT block_sync(0) n')
    const settled = await job.result
    await reading
    assert.equal(settled.outcome.kind, 'committed')
    if (
      settled.outcome.kind !== 'committed' ||
      settled.outcome.value.method !== 'uploadArtifactBlob'
    )
      throw new Error('publication did not commit')
    const artifact = settled.outcome.value.result!
    assert.equal(probe[11], 0)
    probe[8] = 0 // Independent fixture oracle; not product finalization.
    assert.equal(
      await hashFile(join(r.storage.dir, 'artifacts', 't', `${artifact.id}.bin`)),
      source.grant.ref.sha256
    )
    assert.equal(source.consumed(), true)
    assert.equal(source.released(), 1)
    const replay = await r.artifactPublication.start(source.request, source.uploads).result
    assert.equal(replay.outcome.kind, 'committed')
    if (replay.outcome.kind === 'committed') assert.equal(replay.outcome.replayed, true)

    const failed = await stage(r, 'native-fail')
    arm(4)
    probe[10] = 1
    const failure = r.artifactPublication.start(failed.request, failed.uploads)
    await until(() => !!probe[1])
    control('SELECT fail_next_sync() n')
    release()
    const outcome = (await failure.result).outcome
    assert.equal(outcome.kind, 'unconfirmed', JSON.stringify(outcome))
    if (outcome.kind === 'unconfirmed')
      assert.equal(outcome.error.props?.code, 'SQLITE_IOERR_FSYNC')
    assert.equal(failed.consumed(), false)
    await b.handle(M.ping, {}, scoped)
    assert.equal(probe[4], 0)
    assert(probe[3] <= 256 * 1024)
    await b.handle(M.procKill, { sessionId: 'same-id', spawnId: 'one' }, scoped)
    await a.dispose()
    reopenedA = make('publication-a')
    await reopenedA.handle(M.chatRequest, { kind: 'bootstrap', value: bootstrap }, actor)
    const fresh = observed.get('publication-a')!
    const recovered = await fresh.artifactPublication.start(failed.request, failed.uploads).result
    assert.equal(recovered.outcome.kind, 'committed')
    if (recovered.outcome.kind === 'committed') assert.equal(recovered.outcome.replayed, true)
    assert.equal(failed.released(), 1)
    assert.equal(failed.consumed(), false)
    assert.equal(probe[11], 0)
    console.log(
      JSON.stringify({
        mode: 'native',
        actualDispatch: true,
        actualPackagedWorker: true,
        stagedBytes: source.grant.ref.size,
        finalPublicationFullFence: true,
        actorChecked: true,
        multiHubControls: true,
        controlMs,
        zeroWholeWorkerBodyReads: true,
        mainBodyIo: probe[11],
        mainSyncs: control('SELECT sync_count() n') - mainSyncs,
        failedFinalFenceUnconfirmed: true,
        failedFenceFreshOwnerReplay: true,
        sourceLeaseRetainedUntilSettlement: true
      })
    )
  } finally {
    control('SELECT block_sync(0) n')
    release()
    await Promise.all([a.dispose(), b.dispose(), reopenedA?.dispose()])
  }
}
void (async () => {
  try {
    if (mode === 'portable') await portable()
    else if (mode === 'large') await large()
    else if (mode === 'faults') await faults()
    else if (mode === 'relay') await relay()
    else if (mode.startsWith('cache-')) await cachePressure()
    else await native()
    assert.equal(control('SELECT sync_count() n') - mainSyncs, 0)
  } finally {
    release()
    control('SELECT block_sync(0) n')
    for (const r of live) await r.close().catch(() => undefined)
    counter.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
