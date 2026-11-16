/** One canonical writer, its existing artifact journal and immutable blob layout. */
import { randomUUID, createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { serializeError, deserializeError } from '@slayzone/platform/sqlite-worker'
import { artifactFilePathIn, artifactsDirOf } from '@slayzone/task/server/artifact-paths'
import {
  prepareArtifactPublicationFiles,
  closePublicationFile
} from '@slayzone/task-artifacts/publication-files'
import {
  commitPreparedArtifactPublication,
  prepareArtifactPublicationOutputs,
  registerArtifactPublication,
  registerArtifactBlobLifetime,
  recoverWorkingCopies,
  ensureWorkingCopySchema,
  newPublicationArtifactId,
  type PreparedArtifactMutation
} from '@slayzone/task-artifacts/storage'
import type { ChatStorage } from './storage'
import type { createLocalChatData, ChatMetadataUpdate } from './local-data'
import type { ConversationIdentity } from '../shared'
import { chatStorageDigest } from './storage-digest'
import {
  inspectPublicationSchema,
  publicationSourceSchema,
  type InspectPublication,
  type Inspection,
  type OwnerStamp,
  type PublicationContext,
  type PublicationControl,
  type PublicationIntent,
  type PublicationOutcome,
  type PublicationPhase,
  type PublicationSettlement,
  type PublicationStatus,
  type PublishPublication,
  type CancelPublication
} from './artifact-publication-protocol'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const keyOf = (context: PublicationContext) =>
  JSON.stringify([context.route.id, context.operationId])
const same = (a: unknown, b: unknown) => chatStorageDigest(a) === chatStorageDigest(b)
function uncertainIo(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (Reflect.get(error, 'physicalQuiescenceUnconfirmed')) return true
  return (
    uncertainIo(Reflect.get(error, 'cause')) ||
    (error instanceof AggregateError && error.errors.some(uncertainIo))
  )
}
type Job = {
  request?: PublishPublication
  context: PublicationContext
  executionId: string
  phase: PublicationPhase
  cancelled: string | null
  promise: Promise<PublicationSettlement>
  settled?: PublicationSettlement
}

export function createArtifactPublicationOwner(
  storage: ChatStorage,
  local: ReturnType<typeof createLocalChatData>,
  hooks: {
    serialize<T>(work: () => Promise<T>): Promise<T>
    identity<T>(owner: ConversationIdentity, work: () => T): T
    failure(error: unknown): void
    available(): void
    access<T>(taskId: string, work: () => Promise<T>): Promise<T>
  }
) {
  const db = storage.compose((db) => db),
    instanceId = randomUUID()
  ensureWorkingCopySchema(db)
  recoverWorkingCopies(db, storage.dir, { strict: true })
  const jobs = new Map<string, Job>(),
    executions = new Map<string, Job>()
  const completed = new Map<Job, number>()
  let completedBytes = 0
  let closed = false
  const stamp = (): OwnerStamp => ({
    storeId: storage.storeId(),
    instanceId,
    connectionEpoch: storage.maintenance.connectionEpoch()
  })
  function context(request: InspectPublication): PublicationContext {
    const current = storage.conversation(request.route.id)
    if (!current || current.state !== 'active' || current.identity.epoch !== request.route.epoch)
      throw new Error('Artifact ownership is unavailable or deleted')
    if (storage.getRecord(current.identity.id, 'settings', 'tab-transition-pending'))
      throw new Error('Artifact owner has a pending provider transition')
    const lifecycle = storage.taskLifecycle(current.identity.taskId)
    if (lifecycle.state !== 'active') throw new Error('Task chat is paused or deleted')
    const intent = request.intent
    if (intent.method === 'uploadArtifactBlob') {
      const first = intent.args[0]
      if (first.taskId !== current.identity.taskId) throw new Error('Artifact task scope mismatch')
      if (
        first.folderId &&
        !db
          .prepare('SELECT 1 FROM artifact_folders WHERE id=? AND task_id=?')
          .get(first.folderId, current.identity.taskId)
      )
        throw new Error('Folder is outside this task')
    } else if (
      !db
        .prepare('SELECT 1 FROM task_artifacts WHERE id=? AND task_id=?')
        .get(intent.args[0].artifactId, current.identity.taskId)
    )
      throw new Error('Artifact is outside this task')
    return {
      owner: stamp(),
      route: request.route,
      taskId: current.identity.taskId,
      tabId: current.identity.tabId,
      lifecycleRevision: lifecycle.revision,
      operationId: request.operationId,
      intentHash: chatStorageDigest(intent)
    }
  }
  function validate(job: Job) {
    hooks.available()
    if (job.cancelled) throw new Error(`Artifact publication cancelled: ${job.cancelled}`)
    const request = job.request
    if (!request) throw new Error('Artifact publication already settled')
    const fresh = context({
      route: request.context.route,
      operationId: request.context.operationId,
      intent: request.intent
    })
    if (!same(fresh, request.context))
      throw new Error('Artifact publication owner or lifecycle changed')
    return storage.conversation(fresh.route.id)!.identity
  }
  const fence = async () => {
    try {
      await storage.flush()
    } catch (error) {
      hooks.failure(error)
      throw error
    }
  }
  async function inspect(raw: InspectPublication): Promise<Inspection> {
    if (closed) throw new Error('Artifact publication admission is closed')
    const request = inspectPublicationSchema.parse(raw),
      ctx = context(request)
    const running = jobs.get(keyOf(ctx))
    if (running) {
      if (running.context.intentHash !== ctx.intentHash)
        throw new Error('Operation id reused with different input')
      return { kind: 'join', context: ctx, executionId: running.executionId }
    }
    const receipt = storage.receipt(ctx.route.id, ctx.operationId)
    if (receipt) {
      storage.acceptCommand(ctx.route.id, ctx.route.epoch, ctx.operationId, request.intent)
      if (receipt.resultExpired)
        throw new Error(
          'Artifact operation result expired under chat retention; operation was not repeated'
        )
      if (receipt.state !== 'delivered')
        return {
          kind: 'unconfirmed',
          error: serializeError(new Error('Artifact operation outcome is unconfirmed'))
        }
      try {
        await fence()
      } catch (error) {
        return { kind: 'unconfirmed', error: serializeError(error) }
      }
      return {
        kind: 'replay',
        context: ctx,
        value: {
          method: request.intent.method,
          result: receipt.result
        } as import('./artifact-publication-protocol').PublicationValue
      }
    }
    return { kind: 'admit', context: ctx }
  }
  async function source(job: Job) {
    const request = job.request!,
      first = request.intent.args[0]
    if (!first.staged) {
      if (request.source) throw new Error('Inline publication cannot carry a staged grant')
      return { data: first.data! }
    }
    const grant = publicationSourceSchema.parse(request.source),
      ctx = request.context
    if (!same(grant.ref, first.staged) || grant.identity.size !== grant.ref.size)
      throw new Error('Publication source reference mismatch')
    let expected: string
    if (grant.binding.kind === 'owned') {
      const binding = grant.binding
      if (
        binding.taskId !== ctx.taskId ||
        !same(binding.route, ctx.route) ||
        binding.operationId !== ctx.operationId ||
        binding.revision !== ctx.lifecycleRevision
      )
        throw new Error('Publication source binding mismatch')
      const uploadId = digest([
        ctx.taskId,
        { id: ctx.route.id, epoch: ctx.route.epoch },
        ctx.operationId,
        binding.revision
      ])
      if (grant.ref.uploadId !== uploadId)
        throw new Error('Publication upload incarnation mismatch')
      expected = join(
        storage.dir,
        'uploads',
        'owned',
        digest(ctx.taskId),
        digest(ctx.route.id),
        uploadId,
        'data.part'
      )
    } else {
      if (grant.ref.uploadId) throw new Error('Owned upload cannot use a legacy grant')
      expected = join(storage.dir, 'uploads', `${grant.ref.sha256}-${grant.ref.size}.part`)
    }
    if (grant.path !== expected || (await realpath(expected)) !== expected)
      throw new Error('Publication source is outside its canonical path')
    validate(job)
    // Every path component must still be a real directory; no symlink/reparse ancestor.
    for (let path = dirname(expected); path !== storage.dir; path = dirname(path)) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Publication source has a symlink ancestor')
      validate(job)
    }
    if (grant.binding.kind === 'owned') {
      const manifest = join(dirname(expected), 'manifest.json')
      const file = await open(manifest, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > 16 * 1024)
          throw new Error('Invalid publication upload manifest')
        const value = JSON.parse(await file.readFile('utf8'))
        const binding = grant.binding
        if (
          value.version !== 1 ||
          value.taskId !== ctx.taskId ||
          !same(value.route, ctx.route) ||
          value.operationId !== ctx.operationId ||
          value.revision !== binding.revision ||
          value.sha256 !== grant.ref.sha256 ||
          value.size !== grant.ref.size
        )
          throw new Error('Publication upload manifest changed')
      } finally {
        await closePublicationFile(file)
      }
    }
    validate(job)
    const current = await lstat(expected, { bigint: true })
    if (
      !current.isFile() ||
      String(current.dev) !== grant.identity.dev ||
      String(current.ino) !== grant.identity.ino ||
      Number(current.size) !== grant.identity.size
    )
      throw new Error('Publication source identity or size changed')
    validate(job)
    return {
      path: expected,
      sha256: grant.ref.sha256,
      size: grant.ref.size,
      identity: { dev: grant.identity.dev, ino: grant.identity.ino }
    }
  }
  function control(input: PublicationControl): Job | undefined {
    if (!same(input.owner, stamp())) throw new Error('Artifact publication control owner changed')
    const job = executions.get(input.executionId)
    if (
      job &&
      (job.context.route.id !== input.key.conversationId ||
        job.context.operationId !== input.key.operationId)
    )
      throw new Error('Artifact publication control key mismatch')
    return job
  }
  function status(input: PublicationControl): PublicationStatus {
    const job = control(input)
    if (!job) return { ...input, kind: 'absent' }
    return job.settled
      ? { ...job.settled, executionId: input.executionId }
      : { ...input, kind: 'running', phase: job.phase }
  }
  async function cancel(input: CancelPublication): Promise<PublicationSettlement> {
    const job = control(input)
    if (!job) throw new Error('Unknown artifact publication execution')
    job.cancelled ??= input.reason
    return { ...(await job.promise), executionId: input.executionId }
  }
  function publish(raw: PublishPublication): Promise<PublicationSettlement> {
    if (closed) return Promise.reject(new Error('Artifact publication admission is closed'))
    const parsed = inspectPublicationSchema.parse({
      route: raw.context.route,
      operationId: raw.context.operationId,
      intent: raw.intent
    })
    const request = { ...raw, intent: parsed.intent },
      key = keyOf(request.context)
    if (
      typeof request.executionId !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.executionId)
    )
      return Promise.reject(new Error('Invalid publication execution id'))
    const existing = jobs.get(key)
    if (existing) {
      if (existing.context.intentHash !== chatStorageDigest(parsed.intent))
        return Promise.reject(new Error('Operation id reused with different input'))
      if (!same(context(parsed), request.context))
        return Promise.reject(new Error('Artifact publication owner or lifecycle changed'))
      executions.set(request.executionId, existing)
      return existing.promise.then((settled) => ({ ...settled, executionId: request.executionId }))
    }
    if (executions.has(request.executionId))
      return Promise.reject(new Error('Publication execution id was reused'))
    // All pins/admission exist before source/stat/queue/preparation can yield.
    const secondary = storage.maintenance.registerSecondary('artifact publication')
    const releaseBlobs = registerArtifactBlobLifetime(db),
      jobId = randomUUID(),
      releaseJournal = registerArtifactPublication(storage.dir, jobId)
    const job: Job = {
      request,
      context: request.context,
      executionId: request.executionId,
      phase: 'validating',
      cancelled: null,
      promise: undefined!
    }
    jobs.set(key, job)
    executions.set(request.executionId, job)
    const work = hooks.serialize(() =>
      hooks.access(request.context.taskId, async () => {
        let committed = false,
          accepted = false,
          outcome: PublicationOutcome | undefined,
          fatal: unknown,
          physical = false
        try {
          const identity = validate(job)
          const receipt = storage.receipt(request.context.route.id, request.context.operationId)
          if (receipt) {
            storage.acceptCommand(
              identity.id,
              identity.epoch,
              request.context.operationId,
              request.intent
            )
            if (receipt.resultExpired)
              throw new Error(
                'Artifact operation result expired under chat retention; operation was not repeated'
              )
            if (receipt.state !== 'delivered')
              throw new Error('Artifact operation outcome is unconfirmed')
            committed = true
            await fence()
            outcome = {
              kind: 'committed',
              value: {
                method: request.intent.method,
                result: receipt.result
              } as import('./artifact-publication-protocol').PublicationValue,
              durability: 'owner-flush',
              replayed: true,
              metadata: []
            }
          } else {
            const input = await source(job)
            const first = request.intent.args[0]
            const mutation: PreparedArtifactMutation =
              request.intent.method === 'uploadArtifactBlob'
                ? {
                    method: request.intent.method,
                    taskId: request.intent.args[0].taskId,
                    title: request.intent.args[0].title,
                    folderId: request.intent.args[0].folderId,
                    artifactId: newPublicationArtifactId()
                  }
                : {
                    method: request.intent.method,
                    artifactId: request.intent.args[0].artifactId,
                    mutateRef: request.intent.args[0].mutateRef,
                    mutateCurrent: request.intent.args[0].mutateCurrent,
                    author: request.intent.args[0].author,
                    taskId: identity.taskId,
                    title: (
                      db
                        .prepare('SELECT title FROM task_artifacts WHERE id=?')
                        .get(request.intent.args[0].artifactId) as { title: string }
                    ).title
                  }
            job.phase = 'staging'
            const files = await prepareArtifactPublicationFiles({
              dataDir: storage.dir,
              owner: {
                taskId: identity.taskId,
                conversationId: identity.id,
                operationId: request.context.operationId,
                intentHash: request.context.intentHash,
                artifactId: mutation.artifactId
              },
              source: input,
              jobId,
              append: 'append' in first && first.append,
              ...(mutation.method === 'writeArtifactContent'
                ? {
                    previous: {
                      path: artifactFilePathIn(
                        artifactsDirOf(storage.dir),
                        identity.taskId,
                        mutation.artifactId,
                        mutation.title
                      )
                    }
                  }
                : {}),
              assertCurrent: () => {
                validate(job)
              },
              prepareOutputs: async (files) => {
                validate(job)
                storage.acceptCommand(
                  identity.id,
                  identity.epoch,
                  request.context.operationId,
                  request.intent
                )
                accepted = true
                await prepareArtifactPublicationOutputs(storage.dir, files, () => {
                  validate(job)
                })
                await source(job)
              }
            })
            validate(job)
            job.phase = 'committing'
            const metadata: ChatMetadataUpdate[] = []
            const value = hooks.identity(identity, () =>
              storage.transaction(() => {
                validate(job)
                const value = commitPreparedArtifactPublication(db, storage.dir, files, mutation)
                const artifact =
                  value.method === 'uploadArtifactBlob' ? value.result : value.result.artifact
                if (artifact)
                  metadata.push({
                    ...local.metadata(identity.tabId, 'artifact-changed', {
                      id: artifact.id,
                      folderId: artifact.folder_id,
                      order: artifact.order
                    }),
                    storeId: request.context.owner.storeId
                  })
                storage.completeCommand(
                  identity.id,
                  identity.epoch,
                  request.context.operationId,
                  value.result
                )
                return value
              })
            )
            committed = true
            job.phase = 'fencing'
            await fence()
            outcome = {
              kind: 'committed',
              value,
              replayed: false,
              durability: 'owner-flush',
              metadata
            }
          }
        } catch (error) {
          if (uncertainIo(error)) {
            physical = true
            hooks.failure(error)
            fatal = error
          } else
            outcome = committed
              ? { kind: 'unconfirmed', error: serializeError(error) }
              : {
                  kind: 'not-committed',
                  error: serializeError(error),
                  receipt: accepted ? 'accepted-unconfirmed' : 'absent'
                }
        }
        job.phase = 'closing-files'
        if (!physical) {
          releaseJournal()
          releaseBlobs()
          // Sole writer; reconcile markers before another conflicting mutation.
          try {
            recoverWorkingCopies(db, storage.dir, { strict: true })
          } catch (cleanupError) {
            physical = true
            hooks.failure(cleanupError)
            const prior =
              outcome && outcome.kind !== 'committed' ? [deserializeError(outcome.error)] : []
            fatal = new AggregateError(
              [...prior, cleanupError],
              'Artifact publication cleanup failed',
              { cause: cleanupError }
            )
          }
          if (!physical) secondary.release()
        }
        if (fatal) throw fatal
        const settled: PublicationSettlement = {
          kind: 'settled',
          owner: request.context.owner,
          key: {
            conversationId: request.context.route.id,
            operationId: request.context.operationId
          },
          executionId: request.executionId,
          quiescent: true,
          outcome: outcome!
        }
        job.settled = settled
        // Do not retain inline bodies/source grants in completed status observations.
        job.request = undefined
        if (request.intent.args[0].data !== undefined) request.intent.args[0].data = ''
        const size = JSON.stringify(settled).length
        completed.set(job, size)
        completedBytes += size
        // Durable replay belongs to receipts. This volatile status cache has a byte bound.
        for (const [old, bytes] of completed) {
          if (completed.size <= 256 && completedBytes <= 1024 * 1024) break
          completed.delete(old)
          completedBytes -= bytes
          for (const [id, entry] of executions) if (entry === old) executions.delete(id)
        }
        return settled
      })
    )
    job.promise = work.finally(() => {
      if (jobs.get(key) === job) jobs.delete(key)
    })
    return job.promise
  }
  return {
    inspect,
    publish,
    status,
    cancel,
    async close() {
      closed = true
      for (const job of jobs.values()) job.cancelled ??= 'shutdown'
      await Promise.all([...jobs.values()].map((job) => job.promise))
    },
    active: () => jobs.size
  }
}
export type ArtifactPublicationOwner = ReturnType<typeof createArtifactPublicationOwner>
