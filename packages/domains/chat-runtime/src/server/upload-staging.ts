/** Durable operation-owned uploads. Native I/O is async; only conflicting keys queue. */
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { z } from 'zod'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { fsyncFile } from '@slayzone/platform/durable-fs'

type Route = { id: string; epoch: number }
type Owner = { taskId: string; revision: number }
export interface StagedUpload {
  sha256: string
  size: number
  uploadId?: string
}
export interface UploadLease {
  path: string
  size: number
  assertCurrent(): void
  /** Failed consumers retain resumable bytes. Release includes durable cleanup. */
  release(consumed?: boolean): Promise<void>
}
export interface UploadStagingOptions {
  now?: () => number
  staleMs?: number
  automatic?: boolean
  sweepIntervalMs?: number
  onSweepError?(error: unknown): void
  validateOwner?(route: Route): Owner
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const taskFolder = (dir: string, taskId: string) => join(dir, 'uploads', 'owned', digest(taskId))
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
async function info(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (!missing(error)) throw error
    return undefined
  }
}
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function remove(path: string) {
  await rm(path, { recursive: true, force: true })
  if (await info(path)) throw new Error('Computer upload staging remains')
  await syncDirectory(dirname(path))
}
async function* children(path: string) {
  let directory: Awaited<ReturnType<typeof opendir>>
  try {
    directory = await opendir(path)
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  for await (const entry of directory) yield entry
}
/** Restored stores have no live writers; live erasure additionally fences and drains. */
export async function eraseTaskUploads(dir: string, taskId: string): Promise<void> {
  await remove(taskFolder(dir, taskId))
}
export async function assertUploadsErased(dir: string, taskId: string): Promise<void> {
  if (await info(taskFolder(dir, taskId))) throw new Error('Computer upload staging remains')
  const root = join(dir, 'uploads')
  for await (const entry of children(root))
    if (entry.name !== 'owned') throw new Error('Unattributed computer upload staging files remain')
  for await (const entry of children(join(root, 'owned')))
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name))
      throw new Error('Unattributed computer upload staging files remain')
}
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(1).max(200)
const routeSchema = z.object({ id, epoch: z.number().int().positive() })
const manifestSchema = z.object({
  version: z.literal(1),
  taskId: id,
  route: routeSchema,
  operationId: id,
  revision: z.number().int().nonnegative(),
  sha256: hash,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})
type Manifest = z.infer<typeof manifestSchema>
interface Entry {
  key: string
  path: string
  manifest?: Manifest
  refs: number
  consumed: boolean
  discard: boolean
}
interface Work {
  key: string
  owner?: Owner
  route?: Route
  done: Promise<unknown>
  legacy: boolean
}

export function createUploadStaging(dir: string, opts: UploadStagingOptions = {}) {
  const root = join(dir, 'uploads')
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await syncDirectory(dir)
  })()
  void ready.catch(() => undefined) // Methods/close observe initialization failures.
  const now = opts.now ?? Date.now
  const staleMs = opts.staleMs ?? 24 * 60 * 60_000
  const entries = new Map<string, Entry>(),
    touched = new Map<string, number>()
  const erasedTasks = new Set<string>(),
    erasedConversations = new Set<string>()
  const fencedPaths = new Set<string>()
  const pending = new Set<Work>(),
    tails = new Map<string, Promise<void>>()
  const leases = new Set<{ owner: Owner; route: Route; legacy: boolean; done: Promise<void> }>()
  const erasures = new Set<Promise<unknown>>()
  let closed = false,
    legacyEpoch = 0,
    legacyErasing = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let sweeping: Promise<void> | undefined
  let closing: Promise<void> | undefined
  function active() {
    if (closed) throw new Error('Upload staging is closed')
  }
  function ownerOf(route: Route): Owner {
    active()
    routeSchema.parse(route)
    if (!opts.validateOwner) throw new Error('Upload ownership is unavailable')
    const owner = opts.validateOwner(route)
    if (
      erasedTasks.has(owner.taskId) ||
      erasedConversations.has(JSON.stringify([owner.taskId, route.id]))
    )
      throw new Error('Upload owner was deleted')
    return owner
  }
  function validateBytes(sha256: string, size: number) {
    if (!hash.safeParse(sha256).success) throw new Error('Invalid upload hash')
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid upload size')
  }
  function keyFor(sha256: string, size: number, scope?: { route: Route; uploadId: string }) {
    validateBytes(sha256, size)
    if (!scope) return join(root, `${sha256}-${size}.part`)
    const owner = ownerOf(scope.route)
    hash.parse(scope.uploadId)
    return join(taskFolder(dir, owner.taskId), digest(scope.route.id), scope.uploadId)
  }
  /** Register before yielding, including queued work and hash verification before lease creation. */
  function run<T, Result = T>(
    key: string,
    route: Route | undefined,
    legacy: boolean,
    action: (check: () => void, owner?: Owner) => Promise<T>,
    internal = false,
    publish?: (value: T) => Result
  ): Promise<Result> {
    let owner: Owner | undefined, epoch: number
    try {
      if (!internal) {
        active()
        if (route) owner = ownerOf(route)
      }
      epoch = legacyEpoch
      if (legacy && legacyErasing && !internal) throw new Error('Upload erasure is in progress')
    } catch (error) {
      return Promise.reject(error)
    }
    const check = () => {
      if (internal) return
      active()
      if (legacy && (legacyEpoch !== epoch || legacyErasing))
        throw new Error('Upload erasure is in progress')
      if (route && owner) {
        const current = ownerOf(route)
        if (current.taskId !== owner.taskId || current.revision !== owner.revision)
          throw new Error('Upload lifecycle changed')
      }
    }
    const done = (tails.get(key) ?? Promise.resolve()).then(async () => {
      check()
      await ready
      check()
      const value = await action(check, owner)
      check()
      // Lease publication transfers the registered I/O lifetime without an await gap.
      return publish ? publish(value) : (value as unknown as Result)
    })
    const record: Work = { key, route, owner, done, legacy }
    pending.add(record)
    const tail = done
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        pending.delete(record)
        if (tails.get(key) === tail) tails.delete(key)
      })
    tails.set(key, tail)
    return done
  }
  function entryAt(key: string, manifest?: Manifest): Entry {
    let entry = entries.get(key)
    if (!entry) {
      entry = {
        key,
        path: manifest ? join(key, 'data.part') : key,
        manifest,
        refs: 0,
        consumed: false,
        discard: false
      }
      entries.set(key, entry)
    }
    return entry
  }
  async function touch(entry: Entry) {
    const time = now(),
      at = new Date(time)
    await utimes(entry.manifest ? join(entry.key, 'manifest.json') : entry.path, at, at)
    touched.set(entry.key, time)
  }
  async function drop(entry: Entry) {
    if (entries.get(entry.key) !== entry) return
    if (entry.refs) {
      entry.discard = true
      return
    }
    await remove(entry.key)
    entries.delete(entry.key)
    touched.delete(entry.key)
  }
  async function expired(key: string, owned: boolean) {
    const marker = owned ? join(key, 'manifest.json') : key
    const time = touched.get(key) ?? (await info(marker))?.mtimeMs ?? (await info(key))?.mtimeMs
    return time !== undefined && time < now() - staleMs
  }
  async function lookup(
    key: string,
    sha256: string,
    size: number,
    check: () => void,
    scope?: { route: Route; uploadId: string },
    owner?: Owner
  ) {
    if (!(await info(key)))
      throw new Error(
        scope ? 'Upload not staged for this owner' : 'Upload not begun or staged; begin it first'
      )
    check()
    let manifest: Manifest | undefined
    if (scope) {
      manifest = manifestSchema.parse(
        JSON.parse(await readFile(join(key, 'manifest.json'), 'utf8'))
      )
      check()
      if (
        manifest.taskId !== owner!.taskId ||
        manifest.route.id !== scope.route.id ||
        manifest.route.epoch !== scope.route.epoch ||
        manifest.revision !== owner!.revision ||
        manifest.sha256 !== sha256 ||
        manifest.size !== size ||
        digest([manifest.taskId, manifest.route, manifest.operationId, manifest.revision]) !==
          scope.uploadId
      )
        throw new Error('Upload ownership or lifecycle changed')
    }
    const entry = entryAt(key, manifest)
    if (!entry.refs && (await expired(key, !!scope))) {
      check()
      await drop(entry)
      throw new Error('Upload expired; begin it again')
    }
    check()
    return entry
  }
  async function verified(entry: Entry, sha256: string, size: number, check: () => void) {
    const handle = await open(entry.path, 'r')
    try {
      check()
      const here = (await handle.stat()).size
      check()
      if (here !== size) throw new Error(`Upload incomplete: ${here} of ${size} bytes`)
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(BYTE_RANGE_MAX_CHUNK)
      let offset = 0
      while (offset < size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - offset),
          offset
        )
        check()
        if (!bytesRead) throw new Error('Upload incomplete')
        hash.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
        await yieldTurn()
        check()
      }
      if (hash.digest('hex') !== sha256) throw new Error('Upload hash mismatch; send it again')
    } finally {
      await handle.close()
    }
    check()
    await touch(entry)
    check()
  }
  function reportSweepError(error: unknown) {
    try {
      opts.onSweepError?.(error)
    } catch {
      /* Reporting cannot crash expiry. */
    }
  }
  const within = (key: string, path: string) => key === path || key.startsWith(path + sep)
  const fenced = (key: string) => [...fencedPaths].some((path) => within(key, path))
  async function scan() {
    await ready
    await stat(root)
    async function expire(key: string, owned: boolean) {
      // Admission is synchronous with the per-key queue; a new writer/reader wins the key first.
      if (
        closed ||
        fenced(key) ||
        (!owned && legacyErasing) ||
        tails.has(key) ||
        entries.get(key)?.refs
      )
        return
      await run(
        key,
        undefined,
        !owned,
        async () => {
          if (closed || fenced(key) || entries.get(key)?.refs || !(await expired(key, owned)))
            return
          if (closed || fenced(key) || (!owned && legacyErasing)) return
          const entry = entries.get(key)
          if (entry) await drop(entry)
          else await remove(key)
        },
        true
      ).catch(reportSweepError)
    }
    async function scanScope(key: string, scan: () => Promise<void>) {
      if (closed || fenced(key)) return
      // Directory handles and all nested expiry work belong to this scope's drain too.
      await run(
        key,
        undefined,
        false,
        async () => {
          if (!closed && !fenced(key)) await scan()
        },
        true
      )
    }
    for await (const entry of children(root)) {
      if (closed) return
      if (entry.name.endsWith('.part')) await expire(join(root, entry.name), false)
    }
    const owned = join(root, 'owned')
    for await (const task of children(owned)) {
      if (closed) return
      if (!task.isDirectory()) continue
      const taskKey = join(owned, task.name)
      await scanScope(taskKey, async () => {
        for await (const conversation of children(taskKey)) {
          if (closed || fenced(taskKey)) return
          if (!conversation.isDirectory()) continue
          const conversationKey = join(taskKey, conversation.name)
          await scanScope(conversationKey, async () => {
            for await (const operation of children(conversationKey)) {
              if (closed || fenced(conversationKey)) return
              if (operation.isDirectory()) await expire(join(conversationKey, operation.name), true)
            }
          })
        }
      })
    }
  }
  function sweep(): Promise<void> {
    if (closed) return Promise.resolve()
    if (sweeping) return sweeping
    sweeping = scan()
      .catch(reportSweepError)
      .finally(() => {
        sweeping = undefined
      })
    return sweeping
  }
  function eraseOwner(taskId: string, conversationId?: string) {
    const path = conversationId
      ? join(taskFolder(dir, taskId), digest(conversationId))
      : taskFolder(dir, taskId)
    fencedPaths.add(path)
    if (conversationId) erasedConversations.add(JSON.stringify([taskId, conversationId]))
    else erasedTasks.add(taskId)
    const work = (async () => {
      // Pending owned work includes queued begin/chunk/hash and closes all native handles.
      await Promise.allSettled(
        [...pending]
          .filter(
            (p) =>
              within(p.key, path) ||
              (p.owner?.taskId === taskId && (!conversationId || p.route?.id === conversationId))
          )
          .map((p) => p.done)
      )
      await Promise.all(
        [...leases]
          .filter(
            (l) => l.owner.taskId === taskId && (!conversationId || l.route.id === conversationId)
          )
          .map((l) => l.done)
      )
      await remove(path)
      for (const [key, entry] of entries)
        if (
          entry.manifest?.taskId === taskId &&
          (!conversationId || entry.manifest.route.id === conversationId)
        ) {
          entries.delete(key)
          touched.delete(key)
        }
    })()
    erasures.add(work)
    void work.finally(() => erasures.delete(work)).catch(() => undefined)
    return work
  }
  const api = {
    async begin(
      sha256: string,
      size: number,
      scope?: { route: Route; operationId: string }
    ): Promise<{ received: number; uploadId?: string }> {
      const route = scope ? routeSchema.parse(scope.route) : undefined
      const owner = route ? ownerOf(route) : undefined
      if (scope) id.parse(scope.operationId)
      const uploadId = scope
        ? digest([owner!.taskId, route, scope.operationId, owner!.revision])
        : undefined
      const key = keyFor(sha256, size, route ? { route, uploadId: uploadId! } : undefined)
      return run(key, route, !scope, async (check, owner) => {
        let entry = entries.get(key)
        if (!entry?.refs && (await expired(key, !!scope))) {
          check()
          if (entry) await drop(entry)
          else await remove(key)
          entry = undefined
        }
        check()
        if (scope) {
          const marker = join(key, 'manifest.json')
          if (!(await info(marker))) {
            check()
            await mkdir(key, { recursive: true, mode: 0o700 })
            check()
            const manifest: Manifest = {
              version: 1,
              taskId: owner!.taskId,
              route: route!,
              operationId: scope.operationId,
              revision: owner!.revision,
              sha256,
              size
            }
            const temp = join(key, `manifest-${randomUUID()}.tmp`)
            await writeFile(temp, JSON.stringify(manifest), { mode: 0o600 })
            check()
            await fsyncFile(temp)
            check()
            await rename(temp, marker)
            check()
          }
          // A failed begin may have published metadata but not yet created/flushed data.
          const handle = await open(join(key, 'data.part'), 'a', 0o600)
          try {
            check()
            await handle.sync()
            check()
          } finally {
            await handle.close()
          }
          await fsyncFile(marker)
          check()
          for (const parent of [
            key,
            dirname(key),
            dirname(dirname(key)),
            join(root, 'owned'),
            root
          ]) {
            await syncDirectory(parent)
            check()
          }
        } else {
          const handle = await open(key, 'a', 0o600)
          try {
            check()
            await handle.sync()
            check()
          } finally {
            await handle.close()
          }
          await syncDirectory(root)
          check()
        }
        entry = await lookup(
          key,
          sha256,
          size,
          check,
          route ? { route, uploadId: uploadId! } : undefined,
          owner
        )
        await touch(entry)
        check()
        const received = (await stat(entry.path)).size
        check()
        return { received, ...(uploadId ? { uploadId } : {}) }
      })
    },
    async chunk(
      sha256: string,
      size: number,
      offset: number,
      bytes: Uint8Array,
      scope?: { route: Route; uploadId: string }
    ): Promise<{ received: number }> {
      if (bytes.length > BYTE_RANGE_MAX_CHUNK)
        throw new Error(`Upload chunk over ${BYTE_RANGE_MAX_CHUNK} bytes`)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid upload offset')
      const key = keyFor(sha256, size, scope)
      return run(key, scope?.route, !scope, async (check, owner) => {
        const entry = await lookup(key, sha256, size, check, scope, owner)
        if (offset + bytes.length > size) throw new Error('Upload chunk past its declared size')
        const handle = await open(entry.path, 'r+')
        try {
          check()
          const here = (await handle.stat()).size
          check()
          if (offset < here && offset + bytes.length <= here) {
            const held = Buffer.alloc(bytes.length)
            let read = 0
            while (read < held.length) {
              const { bytesRead } = await handle.read(held, read, held.length - read, offset + read)
              check()
              if (!bytesRead) throw new Error('Upload retry bytes differ')
              read += bytesRead
            }
            if (!held.equals(Buffer.from(bytes))) throw new Error('Upload retry bytes differ')
          } else {
            if (offset !== here)
              throw new Error(`Upload chunk at offset ${offset}, expected ${here}`)
            if (entry.refs) throw new Error('Upload is being consumed')
            let written = 0
            while (written < bytes.length) {
              const { bytesWritten } = await handle.write(
                bytes,
                written,
                bytes.length - written,
                offset + written
              )
              check()
              if (!bytesWritten) throw new Error('Upload write made no progress')
              written += bytesWritten
            }
          }
          // Includes retries after failed fsync: never acknowledge an unsynced on-disk offset.
          await handle.sync()
          check()
          await touch(entry)
          check()
          return { received: Math.max(here, offset + bytes.length) }
        } finally {
          await handle.close()
        }
      })
    },
    async take(sha256: string, size: number) {
      const key = keyFor(sha256, size)
      return run(key, undefined, true, async (check) => {
        if (!(await info(key))) throw new Error('Upload not staged on this computer; send it again')
        const entry = await lookup(key, sha256, size, check)
        await verified(entry, sha256, size, check)
        return { path: entry.path, size }
      })
    },
    async acquire(ref: StagedUpload, route: Route, operationId?: string): Promise<UploadLease> {
      const scope = ref.uploadId ? { route, uploadId: ref.uploadId } : undefined
      const key = keyFor(ref.sha256, ref.size, scope)
      return run(
        key,
        route,
        !scope,
        async (check, owner) => {
          const entry = await lookup(key, ref.sha256, ref.size, check, scope, owner)
          if (
            entry.manifest &&
            operationId !== undefined &&
            entry.manifest.operationId !== operationId
          )
            throw new Error('Upload belongs to another operation')
          await verified(entry, ref.sha256, ref.size, check)
          check()
          return () => {
            entry.refs++
            let resolve!: () => void
            const record = {
              owner: owner!,
              route,
              legacy: !scope,
              done: new Promise<void>((done) => {
                resolve = done
              })
            }
            leases.add(record)
            let released: Promise<void> | undefined
            return {
              path: entry.path,
              size: ref.size,
              assertCurrent() {
                if (released || entry.discard) throw new Error('Upload lease is no longer current')
                check()
              },
              release(consumed = true) {
                if (released) return released
                released = run(
                  key,
                  undefined,
                  !scope,
                  async () => {
                    entry.refs--
                    entry.consumed ||= consumed
                    try {
                      if (!entry.refs && (entry.discard || (entry.manifest && entry.consumed)))
                        await drop(entry)
                    } finally {
                      leases.delete(record)
                      resolve()
                    }
                  },
                  true
                )
                return released
              }
            }
          }
        },
        false,
        (publish) => publish()
      )
    },
    async release(sha256: string, size: number) {
      const key = keyFor(sha256, size)
      await run(key, undefined, true, async () => {
        await drop(entries.get(key) ?? entryAt(key))
      })
    },
    sweep,
    async eraseTask(taskId: string) {
      active()
      return eraseOwner(taskId)
    },
    async eraseConversation(taskId: string, conversationId: string) {
      active()
      return eraseOwner(taskId, conversationId)
    },
    /** Hold legacy admission through verification/receipt; unattributed work cannot race the check. */
    async withTaskErasure<T>(taskId: string, finish: () => Promise<T>): Promise<T> {
      active()
      legacyEpoch++
      legacyErasing++
      const work = (async () => {
        // Fence the exact owned scope before waiting for unattributed operations too.
        const outcomes = await Promise.allSettled([
          eraseOwner(taskId),
          (async () => {
            await Promise.allSettled([...pending].filter((p) => p.legacy).map((p) => p.done))
            await Promise.all(
              [...leases].filter((lease) => lease.legacy).map((lease) => lease.done)
            )
          })()
        ])
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
        return finish()
      })()
      erasures.add(work)
      try {
        return await work
      } finally {
        legacyErasing--
        erasures.delete(work)
      }
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true
      if (timer) clearInterval(timer)
      closing = (async () => {
        await ready
        await sweeping
        await Promise.allSettled([...erasures])
        await Promise.allSettled([...pending].map((p) => p.done))
        await Promise.all([...leases].map((l) => l.done))
        await Promise.allSettled([...pending].map((p) => p.done))
      })()
      return closing
    }
  }
  if (opts.automatic) {
    void sweep()
    timer = setInterval(() => {
      void sweep()
    }, opts.sweepIntervalMs ?? Math.min(60_000, staleMs))
    timer.unref()
  }
  return api
}
export type UploadStaging = ReturnType<typeof createUploadStaging>
