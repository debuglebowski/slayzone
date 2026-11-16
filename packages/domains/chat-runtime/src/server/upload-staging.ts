/** Durable operation-owned uploads. Native I/O is async; only conflicting keys queue. */
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  lstat,
  open,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { z } from 'zod'
import { chatRouteSchema } from '../shared'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { fsyncFile } from '@slayzone/platform/durable-fs'
import type { PublicationContext, StagedPublicationRef } from './artifact-publication-protocol'
import type { PublicationUploadLease } from './artifact-publication-client'

type Route = { id: string; epoch: number }
type Owner = { taskId: string; revision: number; storeId?: string; connectionEpoch?: number }
type Check = (() => Promise<void>) & { current(): void }
type Identity = { dev: string; ino: string }
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
  /** Production authority is read on the canonical owner; no main native store. */
  readOwner?(route: Route): Promise<Owner>
  registerLifetime?(): Promise<{ release(): Promise<void> }>
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
const routeSchema = chatRouteSchema
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
  id: string
  key: string
  path: string
  manifest?: Manifest
  refs: number
  consumed: boolean
  discard: boolean
  identity?: Identity
  directoryIdentity?: Identity
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
  const leases = new Set<{
    owner: Owner
    route: Route
    legacy: boolean
    controller: AbortController
    entry: Entry
    done: Promise<void>
  }>()
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
  async function ownerOf(route: Route): Promise<Owner> {
    active()
    routeSchema.parse(route)
    if (!opts.readOwner && !opts.validateOwner) throw new Error('Upload ownership is unavailable')
    const owner = opts.readOwner ? await opts.readOwner(route) : opts.validateOwner!(route)
    active()
    if (
      erasedTasks.has(owner.taskId) ||
      erasedConversations.has(JSON.stringify([owner.taskId, route.id]))
    )
      throw new Error('Upload owner was deleted')
    return owner
  }
  const sameOwner = (one: Owner, two: Owner) =>
    one.taskId === two.taskId &&
    one.revision === two.revision &&
    one.storeId === two.storeId &&
    one.connectionEpoch === two.connectionEpoch
  /** Cover authority/key lookup before the per-key queue can be selected. */
  function admitted<T>(
    route: Route | undefined,
    legacy: boolean,
    work: (owner?: Owner) => Promise<T>
  ) {
    let registration: ReturnType<NonNullable<UploadStagingOptions['registerLifetime']>> | undefined
    try {
      active()
      registration = opts.registerLifetime?.()
    } catch (error) {
      return Promise.reject(error)
    }
    const epoch = legacyEpoch
    let record: Work
    const done = Promise.resolve().then(async () => {
      const lifetime = await registration
      try {
        active()
        const owner = route ? await ownerOf(route) : undefined
        record.owner = owner
        active()
        if (legacy && (legacyEpoch !== epoch || legacyErasing))
          throw new Error('Upload erasure is in progress')
        return await work(owner)
      } finally {
        await lifetime?.release()
      }
    })
    record = { key: '', route, legacy, done }
    pending.add(record)
    void done.finally(() => pending.delete(record)).catch(() => undefined)
    return done
  }
  function validateBytes(sha256: string, size: number) {
    if (!hash.safeParse(sha256).success) throw new Error('Invalid upload hash')
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid upload size')
  }
  function keyFor(
    sha256: string,
    size: number,
    scope?: { route: Route; uploadId: string },
    owner?: Owner
  ) {
    validateBytes(sha256, size)
    if (!scope) return join(root, `${sha256}-${size}.part`)
    if (!owner) throw new Error('Upload ownership is unavailable')
    hash.parse(scope.uploadId)
    return join(taskFolder(dir, owner.taskId), digest(scope.route.id), scope.uploadId)
  }
  /** Register before yielding, including queued work and hash verification before lease creation. */
  function run<T, Result = T>(
    key: string,
    route: Route | undefined,
    legacy: boolean,
    action: (check: Check, owner?: Owner) => Promise<T>,
    internal = false,
    publish?: (value: T) => Result,
    admittedOwner?: Owner
  ): Promise<Result> {
    let owner: Owner | undefined, epoch: number
    try {
      if (!internal) {
        active()
        if (route) {
          if (!admittedOwner) throw new Error('Upload authority was not admitted')
          owner = admittedOwner
        }
      }
      epoch = legacyEpoch
      if (legacy && legacyErasing && !internal) throw new Error('Upload erasure is in progress')
    } catch (error) {
      return Promise.reject(error)
    }
    const current = () => {
      if (internal) return
      active()
      if (legacy && (legacyEpoch !== epoch || legacyErasing))
        throw new Error('Upload erasure is in progress')
      if (route && owner) {
        if (
          erasedTasks.has(owner.taskId) ||
          erasedConversations.has(JSON.stringify([owner.taskId, route.id]))
        )
          throw new Error('Upload owner was deleted')
        if (!opts.readOwner && opts.validateOwner && !sameOwner(opts.validateOwner(route), owner))
          throw new Error('Upload lifecycle changed')
      }
    }
    const check: Check = Object.assign(
      async () => {
        current()
        if (!internal && route && owner && !sameOwner(await ownerOf(route), owner))
          throw new Error('Upload lifecycle changed')
        current()
      },
      { current }
    )
    const done = (tails.get(key) ?? Promise.resolve()).then(async () => {
      await check()
      await ready
      await check()
      const value = await action(check, owner)
      await check()
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
        id: randomUUID(),
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
    const claim = join(dirname(entry.key), `.${basename(entry.key)}-cleanup-${randomUUID()}`)
    fencedPaths.add(claim)
    try {
      try {
        await rename(entry.key, claim)
      } catch (error) {
        if (!missing(error)) throw error
        return
      }
      const identity = await lstat(entry.manifest ? join(claim, 'data.part') : claim, {
        bigint: true
      })
      const directory = entry.manifest ? await lstat(claim, { bigint: true }) : undefined
      if (
        (entry.identity && !sameIdentity(entry.identity, identity)) ||
        (entry.directoryIdentity &&
          (!directory || !sameIdentity(entry.directoryIdentity, directory)))
      ) {
        // A same-path replacement is not this lease's source. Restore it when the
        // slot is free; otherwise leave the attributed claim for verified erasure.
        if (!(await info(entry.key))) await rename(claim, entry.key)
        throw new Error('Upload source incarnation was replaced during cleanup')
      }
      await remove(claim)
      if (entries.get(entry.key) === entry) {
        entries.delete(entry.key)
        touched.delete(entry.key)
      }
    } finally {
      fencedPaths.delete(claim)
    }
  }
  function sameIdentity(expected: Identity, actual: { dev: bigint; ino: bigint }) {
    return expected.dev === String(actual.dev) && expected.ino === String(actual.ino)
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
    check: Check,
    scope?: { route: Route; uploadId: string },
    owner?: Owner
  ) {
    if (!(await info(key)))
      throw new Error(
        scope ? 'Upload not staged for this owner' : 'Upload not begun or staged; begin it first'
      )
    await check()
    let manifest: Manifest | undefined
    if (scope) {
      manifest = manifestSchema.parse(
        JSON.parse(await readFile(join(key, 'manifest.json'), 'utf8'))
      )
      await check()
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
    const path = manifest ? join(key, 'data.part') : key
    const identity = await lstat(path, { bigint: true })
    await check()
    if (!identity.isFile()) throw new Error('Upload source is not a regular file')
    const directory = manifest ? await lstat(key, { bigint: true }) : undefined
    await check()
    let entry = entries.get(key)
    if (
      entry &&
      ((entry.identity && !sameIdentity(entry.identity, identity)) ||
        (entry.directoryIdentity &&
          (!directory || !sameIdentity(entry.directoryIdentity, directory))))
    ) {
      for (const lease of leases)
        if (lease.entry === entry) lease.controller.abort('source-revoked')
      if (entry.refs) throw new Error('Upload source incarnation changed')
      entries.delete(key)
      entry = undefined
    }
    entry ??= entryAt(key, manifest)
    entry.identity ??= { dev: String(identity.dev), ino: String(identity.ino) }
    if (directory)
      entry.directoryIdentity ??= { dev: String(directory.dev), ino: String(directory.ino) }
    if (!entry.refs && (await expired(key, !!scope))) {
      await check()
      await drop(entry)
      throw new Error('Upload expired; begin it again')
    }
    await check()
    return entry
  }
  function hold(
    entry: Entry,
    size: number,
    route: Route,
    owner: Owner,
    legacy: boolean,
    check: Check
  ) {
    check.current()
    const registration = opts.registerLifetime?.()
    void registration?.catch(() => undefined)
    entry.refs++
    let resolve!: () => void
    const controller = new AbortController()
    const record = {
      owner,
      route,
      legacy,
      controller,
      entry,
      done: new Promise<void>((done) => {
        resolve = done
      })
    }
    leases.add(record)
    let released: Promise<void> | undefined
    return {
      path: entry.path,
      size,
      signal: controller.signal,
      assertCurrent() {
        if (released || entry.discard || controller.signal.aborted)
          throw new Error('Upload lease is no longer current')
        check.current()
      },
      release(consumed = true) {
        if (released) return released
        released = run(
          entry.key,
          undefined,
          legacy,
          async () => {
            entry.refs--
            entry.consumed ||= consumed
            try {
              if (!entry.refs && (entry.discard || (entry.manifest && entry.consumed)))
                await drop(entry)
            } finally {
              try {
                await (await registration)?.release()
              } finally {
                leases.delete(record)
                resolve()
              }
            }
          },
          true
        )
        return released
      }
    }
  }
  async function verified(entry: Entry, sha256: string, size: number, check: Check) {
    const handle = await open(entry.path, 'r')
    try {
      await check()
      const here = (await handle.stat()).size
      await check()
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
        await check()
        if (!bytesRead) throw new Error('Upload incomplete')
        hash.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
        await yieldTurn()
        await check()
      }
      if (hash.digest('hex') !== sha256) throw new Error('Upload hash mismatch; send it again')
    } finally {
      await handle.close()
    }
    await check()
    await touch(entry)
    await check()
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
    for (const lease of leases)
      if (lease.owner.taskId === taskId && (!conversationId || lease.route.id === conversationId)) {
        if (!lease.legacy) lease.entry.discard = true
        lease.controller.abort('lifecycle-fence')
      }
    const work = (async () => {
      // Pending owned work includes queued begin/chunk/hash and closes all native handles.
      await Promise.allSettled(
        [...pending]
          .filter(
            (p) =>
              (p.route !== undefined && p.owner === undefined) ||
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
    ready: () => ready,
    async begin(
      sha256: string,
      size: number,
      scope?: { route: Route; operationId: string }
    ): Promise<{ received: number; uploadId?: string }> {
      const route = scope ? routeSchema.parse(scope.route) : undefined
      return admitted(route, !scope, async (owner) => {
        if (scope) id.parse(scope.operationId)
        const uploadId = scope
          ? digest([owner!.taskId, route, scope.operationId, owner!.revision])
          : undefined
        const key = keyFor(sha256, size, route ? { route, uploadId: uploadId! } : undefined, owner)
        return run(
          key,
          route,
          !scope,
          async (check, owner) => {
            let entry = entries.get(key)
            if (!entry?.refs && (await expired(key, !!scope))) {
              await check()
              if (entry) await drop(entry)
              else await remove(key)
              entry = undefined
            }
            await check()
            if (scope) {
              const marker = join(key, 'manifest.json')
              if (!(await info(marker))) {
                await check()
                await mkdir(key, { recursive: true, mode: 0o700 })
                await check()
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
                await check()
                await fsyncFile(temp)
                await check()
                await rename(temp, marker)
                await check()
              }
              // A failed begin may have published metadata but not yet created/flushed data.
              const handle = await open(join(key, 'data.part'), 'a', 0o600)
              try {
                await check()
                await handle.sync()
                await check()
              } finally {
                await handle.close()
              }
              await fsyncFile(marker)
              await check()
              for (const parent of [
                key,
                dirname(key),
                dirname(dirname(key)),
                join(root, 'owned'),
                root
              ]) {
                await syncDirectory(parent)
                await check()
              }
            } else {
              const handle = await open(key, 'a', 0o600)
              try {
                await check()
                await handle.sync()
                await check()
              } finally {
                await handle.close()
              }
              await syncDirectory(root)
              await check()
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
            await check()
            const received = (await stat(entry.path)).size
            await check()
            return { received, ...(uploadId ? { uploadId } : {}) }
          },
          false,
          undefined,
          owner
        )
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
      return admitted(scope?.route, !scope, async (owner) => {
        const key = keyFor(sha256, size, scope, owner)
        return run(
          key,
          scope?.route,
          !scope,
          async (check, owner) => {
            const entry = await lookup(key, sha256, size, check, scope, owner)
            if (offset + bytes.length > size) throw new Error('Upload chunk past its declared size')
            const handle = await open(entry.path, 'r+')
            try {
              await check()
              const here = (await handle.stat()).size
              await check()
              if (offset < here && offset + bytes.length <= here) {
                const held = Buffer.alloc(bytes.length)
                let read = 0
                while (read < held.length) {
                  const { bytesRead } = await handle.read(
                    held,
                    read,
                    held.length - read,
                    offset + read
                  )
                  await check()
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
                  await check()
                  if (!bytesWritten) throw new Error('Upload write made no progress')
                  written += bytesWritten
                }
              }
              // Includes retries after failed fsync: never acknowledge an unsynced on-disk offset.
              await handle.sync()
              await check()
              await touch(entry)
              await check()
              return { received: Math.max(here, offset + bytes.length) }
            } finally {
              await handle.close()
            }
          },
          false,
          undefined,
          owner
        )
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
      return admitted(route, !scope, async (owner) => {
        const key = keyFor(ref.sha256, ref.size, scope, owner)
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
            await check()
            return () => hold(entry, ref.size, route, owner!, !scope, check)
          },
          false,
          (publish) => publish(),
          owner
        )
      })
    },
    async reserveForPublication(
      ref: StagedPublicationRef,
      context: PublicationContext
    ): Promise<PublicationUploadLease & { signal: AbortSignal }> {
      const route = routeSchema.parse(context.route)
      const scope = ref.uploadId ? { route, uploadId: ref.uploadId } : undefined
      return admitted(route, !scope, async (owner) => {
        if (
          !owner ||
          owner.taskId !== context.taskId ||
          owner.revision !== context.lifecycleRevision ||
          (owner.storeId !== undefined && owner.storeId !== context.owner.storeId) ||
          (owner.connectionEpoch !== undefined &&
            owner.connectionEpoch !== context.owner.connectionEpoch)
        )
          throw new Error('Publication upload authority changed')
        const key = keyFor(ref.sha256, ref.size, scope, owner)
        return run(
          key,
          route,
          !scope,
          async (check, current) => {
            const entry = await lookup(key, ref.sha256, ref.size, check, scope, current)
            if (
              entry.manifest &&
              entry.manifest.operationId !== context.operationId &&
              ref.uploadId !== context.operationId
            )
              throw new Error('Upload belongs to another operation')
            const identity = await lstat(entry.path, { bigint: true })
            await check()
            if (
              !identity.isFile() ||
              Number(identity.size) !== ref.size ||
              !sameIdentity(entry.identity!, identity)
            )
              throw new Error('Publication upload source incarnation or size changed')
            return () => {
              const lease = hold(entry, ref.size, route, current!, !scope, check)
              return {
                signal: lease.signal,
                assertCurrent: lease.assertCurrent,
                release: lease.release,
                grant: {
                  kind: 'staged-path' as const,
                  leaseId: randomUUID(),
                  entryId: entry.id,
                  path: entry.path,
                  ref: { ...ref },
                  identity: {
                    dev: String(identity.dev),
                    ino: String(identity.ino),
                    size: ref.size
                  },
                  binding: entry.manifest
                    ? {
                        kind: 'owned' as const,
                        taskId: entry.manifest.taskId,
                        route: { ...entry.manifest.route },
                        operationId: entry.manifest.operationId,
                        revision: entry.manifest.revision
                      }
                    : { kind: 'legacy' as const }
                }
              }
            }
          },
          false,
          (publish) => publish(),
          owner
        )
      })
    },
    async release(sha256: string, size: number) {
      const key = keyFor(sha256, size)
      await run(key, undefined, true, async () => {
        await drop(entries.get(key) ?? entryAt(key))
      })
    },
    sweep,
    revokeTask(taskId: string) {
      for (const lease of leases)
        if (lease.owner.taskId === taskId) {
          if (!lease.legacy) lease.entry.discard = true
          lease.controller.abort('lifecycle-fence')
        }
    },
    revokeConversation(conversationId: string) {
      for (const lease of leases)
        if (lease.route.id === conversationId) {
          if (!lease.legacy) lease.entry.discard = true
          lease.controller.abort('lifecycle-fence')
        }
    },
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
      for (const lease of leases) lease.controller.abort('shutdown')
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
