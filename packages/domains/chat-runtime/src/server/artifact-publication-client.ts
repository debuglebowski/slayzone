/** Main owns exact upload leases; all file bodies/SQLite publication stay on the owner. */
import { randomUUID } from 'node:crypto'
import { serializeError, deserializeError } from '@slayzone/platform/sqlite-worker'
import type { AsyncChatStorage } from './storage-owner'
import { chatStorageDigest } from './storage-digest'
import type {
  CancelReason,
  Inspection,
  InspectPublication,
  PublicationContext,
  PublicationControl,
  PublicationSettlement,
  PublicationSourceGrant,
  PublicationIntent,
  PublishPublication,
  StagedPublicationRef
} from './artifact-publication-protocol'

export interface PublicationUploadLease {
  readonly grant: PublicationSourceGrant
  readonly signal?: AbortSignal
  assertCurrent(): void
  release(consumed: boolean): Promise<void>
}
export interface PublicationUploads {
  reserveForPublication(
    ref: StagedPublicationRef,
    context: PublicationContext
  ): Promise<PublicationUploadLease>
}
export interface ArtifactPublicationExecution {
  readonly executionId: string
  readonly result: Promise<PublicationSettlement>
  readonly quiesced: Promise<void>
  cancel(reason: CancelReason): Promise<PublicationSettlement>
}
type Entry = {
  id: string
  hash: string
  request?: InspectPublication
  context?: PublicationContext
  inspected: Promise<void>
  inspectedDone(): void
  cancelled?: CancelReason
  posted: boolean
  waiters: Set<symbol>
  result: Promise<PublicationSettlement>
  quiesced: Promise<void>
  quiet(): void
  cancelling?: Promise<PublicationSettlement>
}
export function createArtifactPublicationClient(
  storage: AsyncChatStorage,
  hooks: {
    assertCurrent?(context: PublicationContext): void
    failure?(error: unknown): void
  } = {}
) {
  const entries = new Map<string, Entry>()
  let closed = false
  const call = <T>(
    method: 'inspect' | 'publish',
    request: InspectPublication | PublishPublication
  ) =>
    storage.db.namedTxn('chatRuntime.call', {
      group: 'artifactPublication',
      method,
      args: [request]
    } as import('./computer-store-protocol').StoreCall) as Promise<T>
  const control = (entry: Entry): PublicationControl => ({
    owner: entry.context!.owner,
    key: { conversationId: entry.context!.route.id, operationId: entry.context!.operationId },
    executionId: entry.id
  })
  const matches = (entry: Entry, value: PublicationSettlement) => {
    if (
      value.kind !== 'settled' ||
      value.quiescent !== true ||
      value.executionId !== entry.id ||
      chatStorageDigest(value.owner) !== chatStorageDigest(entry.context!.owner) ||
      value.key.conversationId !== entry.request!.route.id ||
      value.key.operationId !== entry.request!.operationId
    )
      throw new Error('Artifact publication settlement identity mismatch')
    return value
  }
  function cancellation(entry: Entry, reason: CancelReason) {
    if (!entry.request) return // Its matched physical settlement already completed.
    entry.cancelled ??= reason
    if (entry.posted)
      entry.cancelling ??= storage.publicationControl('cancel', { ...control(entry), reason })
    // Before-post cancellation is observed after pending reservation finishes.
    void entry.cancelling?.catch(() => undefined)
  }
  function start(
    rawRequest: InspectPublication,
    uploads?: PublicationUploads
  ): ArtifactPublicationExecution {
    if (closed) throw new Error('Artifact publication admission is closed')
    const key = JSON.stringify([rawRequest.route.id, rawRequest.operationId]),
      hash = chatStorageDigest({
        ...rawRequest.intent,
        args: [{ ...rawRequest.intent.args[0], data: undefined }]
      })
    let entry = entries.get(key)
    if (
      entry &&
      (entry.hash !== hash || entry.request!.intent.args[0].data !== rawRequest.intent.args[0].data)
    )
      throw new Error('Operation id reused with different input')
    if (!entry) {
      const first = { ...rawRequest.intent.args[0] }
      if (first.staged) first.staged = { ...first.staged }
      if ('author' in first && first.author) first.author = { ...first.author }
      const request: InspectPublication = {
        route: { ...rawRequest.route },
        operationId: rawRequest.operationId,
        intent: { method: rawRequest.intent.method, args: [first] } as PublicationIntent
      }

      let quiet!: () => void, inspectedDone!: () => void
      entry = {
        id: randomUUID(),
        hash,
        request,
        posted: false,
        waiters: new Set(),
        inspected: new Promise<void>((resolve) => {
          inspectedDone = resolve
        }),
        inspectedDone: () => inspectedDone(),
        quiesced: new Promise<void>((resolve) => {
          quiet = resolve
        }),
        quiet: () => quiet(),
        result: undefined!
      }
      const accepted = entry
      entries.set(key, accepted)
      // This reserves the existing owner lifetime synchronously before inspect/source awaits.
      const registering = storage.maintenance.registerSecondary('main artifact publication source')
      accepted.result = (async () => {
        let lifetime: Awaited<typeof registering> | undefined,
          lease: PublicationUploadLease | undefined
        let settled: PublicationSettlement | undefined,
          error: unknown,
          termination: Promise<void> | undefined,
          cleanupFailed = false
        let revokeSource: (() => void) | undefined
        try {
          lifetime = await registering
          let inspection = await call<Inspection>('inspect', request)
          if (inspection.kind === 'unconfirmed') throw deserializeError(inspection.error)
          accepted.context = inspection.context
          accepted.inspectedDone()
          if (inspection.kind === 'replay') {
            settled = {
              kind: 'settled',
              ...control(accepted),
              quiescent: true,
              outcome: {
                kind: 'committed',
                value: inspection.value,
                replayed: true,
                durability: 'owner-flush',
                metadata: []
              }
            }
          } else {
            const first = request.intent.args[0]
            if (inspection.kind !== 'join' && first.staged) {
              if (!uploads)
                throw new Error('Staged publication requires a trusted upload reservation')
              try {
                lease = await uploads.reserveForPublication(first.staged, inspection.context)
                const sourceSignal = lease.signal
                if (sourceSignal) {
                  const revoke = () => cancellation(accepted, 'source-revoked')
                  sourceSignal.addEventListener('abort', revoke, { once: true })
                  revokeSource = () => sourceSignal.removeEventListener('abort', revoke)
                  if (sourceSignal.aborted) revoke()
                }
              } catch (reservationError) {
                // Another successful consumer may have removed the source after inspection.
                const replay = await call<Inspection>('inspect', request)
                if (replay.kind === 'unconfirmed') throw deserializeError(replay.error)
                if (replay.kind === 'join') {
                  inspection = replay
                  accepted.context = replay.context
                } else if (replay.kind !== 'replay') throw reservationError
                else
                  settled = {
                    kind: 'settled',
                    ...control(accepted),
                    quiescent: true,
                    outcome: {
                      kind: 'committed',
                      value: replay.value,
                      replayed: true,
                      durability: 'owner-flush',
                      metadata: []
                    }
                  }
              }
            }
            if (!settled) {
              lease?.assertCurrent()
              hooks.assertCurrent?.(inspection.context)
              if (accepted.cancelled) {
                settled = {
                  kind: 'settled',
                  ...control(accepted),
                  quiescent: true,
                  outcome: {
                    kind: 'not-committed',
                    receipt: 'absent',
                    error: serializeError(
                      new Error(`Artifact publication cancelled: ${accepted.cancelled}`)
                    )
                  }
                }
              } else {
                accepted.posted = true
                const posted = call<PublicationSettlement>('publish', {
                  executionId: accepted.id,
                  context: inspection.context,
                  intent: request.intent,
                  ...(lease ? { source: lease.grant } : {})
                })
                try {
                  settled = matches(accepted, await posted)
                } catch (transportError) {
                  // A rejected RPC is never physical quiescence. Try the privileged matched lane.
                  try {
                    settled = matches(
                      accepted,
                      await storage.publicationControl('cancel', {
                        ...control(accepted),
                        reason: accepted.cancelled ?? 'shutdown'
                      })
                    )
                  } catch (cancelError) {
                    hooks.failure?.(transportError)
                    termination = storage.terminate()
                    void termination.catch(() => undefined)
                    await storage.exited // Independent barrier, not lease-dependent close/terminate.
                    throw new AggregateError(
                      [transportError, cancelError],
                      'Publication transport failed; physical owner exited',
                      { cause: transportError }
                    )
                  }
                }
              }
            }
          }
        } catch (caught) {
          error = caught
          if (!accepted.posted && accepted.context)
            settled = {
              kind: 'settled',
              ...control(accepted),
              quiescent: true,
              outcome: { kind: 'not-committed', receipt: 'absent', error: serializeError(caught) }
            }
        } finally {
          accepted.inspectedDone()
          // Only a matched settlement, never-posted work, or actual exit reaches this point.
          accepted.quiet()
          revokeSource?.()
          try {
            await lease?.release(settled?.outcome.kind === 'committed')
          } catch (cleanupError) {
            cleanupFailed = true
            error = new AggregateError(
              [...(error ? [error] : []), cleanupError],
              'Publication source cleanup failed',
              { cause: settled ?? error }
            )
          }
          try {
            await lifetime?.release()
          } catch (cleanupError) {
            cleanupFailed = true
            error = new AggregateError(
              [...(error ? [error] : []), cleanupError],
              'Publication lifetime cleanup failed',
              { cause: settled ?? error }
            )
          }
          if (termination)
            await termination.catch((terminationError) => {
              error = new AggregateError(
                [error, terminationError],
                'Publication owner cleanup failed',
                { cause: error }
              )
            })
          if (entries.get(key) === accepted) entries.delete(key)
          accepted.request = undefined
          if (request.intent.args[0].data !== undefined) request.intent.args[0].data = ''
        }
        if (error && !settled) throw error
        if (cleanupFailed || (error && settled && settled.outcome.kind === 'committed')) throw error
        return settled!
      })()
      void accepted.result.catch(() => undefined)
    }
    const current = entry,
      waiter = Symbol('publication waiter')
    current.waiters.add(waiter)
    const result = current.result.finally(() => current.waiters.delete(waiter))
    return {
      executionId: current.id,
      result,
      quiesced: current.quiesced,
      cancel(reason) {
        current.waiters.delete(waiter)
        if (reason !== 'request-aborted' || !current.waiters.size) cancellation(current, reason)
        return result
      }
    }
  }
  return {
    start,
    inspect: (request: InspectPublication) => call<Inspection>('inspect', request),
    async cancelTask(taskId: string) {
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          await entry.inspected
          if (entry.context?.taskId === taskId) {
            cancellation(entry, 'lifecycle-fence')
            await entry.result
          }
        })
      )
    },
    async cancelConversation(id: string) {
      const pending = [...entries.values()].filter((entry) => entry.request!.route.id === id)
      for (const entry of pending) cancellation(entry, 'lifecycle-fence')
      await Promise.all(pending.map((entry) => entry.result))
    },
    async close() {
      closed = true
      const pending = [...entries.values()]
      for (const entry of pending) cancellation(entry, 'shutdown')
      await Promise.all(pending.map((entry) => entry.result))
    }
  }
}
export type ArtifactPublicationClient = ReturnType<typeof createArtifactPublicationClient>
