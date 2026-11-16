import { createHash, randomUUID, type Hash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, rmdir, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'
import { isPathSafeId } from '@slayzone/platform/safe-path'
import { workingCopyJournalDir } from './working-copy'

export interface PublicationFileIdentity {
  dev: string
  ino: string
}

export interface PublicationSourceFile {
  path: string
  sha256: string
  size: number
  identity: PublicationFileIdentity
}

export interface PublicationFileSnapshot extends PublicationFileIdentity {
  size: number
  mtimeNs: string
  ctimeNs: string
}

export interface PublicationPreparationOwner {
  taskId: string
  conversationId: string
  operationId: string
  intentHash: string
}

export interface PrepareArtifactPublicationFilesOptions {
  /** Validated, exclusively owned storage root. No filesystem paths cross public RPC here. */
  dataDir: string
  owner: PublicationPreparationOwner
  source: PublicationSourceFile
  /** Live working bytes may differ from immutable HEAD. Missing initially means no before image. */
  previous?: { path: string; expected?: Omit<PublicationSourceFile, 'path'> }
  append?: boolean
  /** Optional private UUID, never an artifact/task id. Existing directories are refused. */
  jobId?: string
  signal?: AbortSignal
  /** Worker-local lifecycle fence; must throw synchronously when no longer current. */
  assertCurrent?: () => void
}

export interface PreparedPublicationImage {
  path: string
  sha256: string
  size: number
}

export interface PreparedArtifactPublicationFiles {
  jobId: string
  directory: string
  ownershipFile: string
  source: Omit<PublicationSourceFile, 'path'>
  before: (PreparedPublicationImage & { sourceSnapshot: PublicationFileSnapshot }) | null
  after: PreparedPublicationImage
  /** Only after publication/recovery no longer needs the images. Waits for native cleanup. */
  cleanup(): Promise<'removed' | 'absent' | 'replaced'>
}

const BUFFER_BYTES = 256 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
type Check = () => void
type CleanupResult = Awaited<ReturnType<PreparedArtifactPublicationFiles['cleanup']>>

// Serialize only users of the same private path. Unrelated preparations/control work stay live.
const paths = new Map<string, Promise<void>>()
async function withPath<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = paths.get(path) ?? Promise.resolve()
  let unlock!: () => void
  const next = new Promise<void>((resolve) => {
    unlock = resolve
  })
  paths.set(path, next)
  await previous
  try {
    return await action()
  } finally {
    unlock()
    if (paths.get(path) === next) paths.delete(path)
  }
}

const identity = (s: BigIntStats): PublicationFileIdentity => ({
  dev: String(s.dev),
  ino: String(s.ino)
})
const sameIdentity = (a: PublicationFileIdentity, b: PublicationFileIdentity) =>
  a.dev === b.dev && a.ino === b.ino
const snapshot = (s: BigIntStats): PublicationFileSnapshot => ({
  ...identity(s),
  size: Number(s.size),
  mtimeNs: String(s.mtimeNs),
  ctimeNs: String(s.ctimeNs)
})
const sameSnapshot = (a: PublicationFileSnapshot, b: PublicationFileSnapshot) =>
  sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const missing = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
const noCheck: Check = () => undefined
const boundedId = (value: string, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max

function validateSource(source: Omit<PublicationSourceFile, 'path'>): void {
  if (
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    !SHA256.test(source.sha256) ||
    !/^\d+$/.test(source.identity.dev) ||
    !/^\d+$/.test(source.identity.ino)
  )
    throw new Error('Invalid publication source expectation')
}

async function checked<T>(promise: Promise<T>, check: Check): Promise<T> {
  const result = await promise
  check()
  return result
}

// Acquire handles before checking cancellation, so a post-open fence cannot leak a descriptor.
async function usingFile<T>(
  path: string,
  flags: number | string,
  check: Check,
  use: (file: FileHandle) => Promise<T>
): Promise<T> {
  check()
  const file = await open(path, flags, 0o600)
  let value!: T,
    failure: unknown,
    failed = false
  try {
    check()
    value = await use(file)
  } catch (error) {
    failure = error
    failed = true
  }
  // Closing must finish even when the caller is cancelled. Preserve both errors rather than
  // replacing an I/O failure with a close failure from a finally block.
  try {
    await file.close()
  } catch (error) {
    failure = failed
      ? new AggregateError([failure, error], 'Publication I/O and close failed', { cause: failure })
      : error
    failed = true
  }
  if (failed) throw failure
  check()
  return value
}

async function syncDirectory(path: string, check: Check): Promise<void> {
  // Same platform policy as working-copy.ts and platform/durable-fs. Output handles are writable
  // and sync directly below; reopening a pathname here would lose the same-descriptor guarantee.
  if (process.platform === 'win32') {
    check()
    return
  }
  await usingFile(path, 'r', check, async (file) => {
    await checked(file.sync(), check)
  })
}

async function writeAll(file: FileHandle, bytes: Buffer, check: Check): Promise<void> {
  for (let offset = 0; offset < bytes.length; ) {
    const { bytesWritten } = await checked(
      file.write(bytes, offset, bytes.length - offset, null),
      check
    )
    if (bytesWritten <= 0) throw new Error('Publication write made no progress')
    offset += bytesWritten
  }
}

async function copyVerified(
  source: { path: string; expected?: Omit<PublicationSourceFile, 'path'> },
  outputs: Array<{ file: FileHandle; hash?: Hash }>,
  buffer: Buffer,
  check: Check,
  optional = false
): Promise<{ sha256: string; size: number; sourceSnapshot: PublicationFileSnapshot } | null> {
  let initial: BigIntStats
  try {
    initial = await checked(lstat(source.path, { bigint: true }), check)
  } catch (error) {
    if (optional && !source.expected && missing(error)) return null
    throw error
  }
  if (!initial.isFile()) throw new Error('Publication input is not a regular file')
  return usingFile(
    source.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    check,
    async (file) => {
      const start = await checked(file.stat({ bigint: true }), check),
        before = snapshot(start)
      if (
        !start.isFile() ||
        !sameIdentity(identity(initial), before) ||
        !Number.isSafeInteger(before.size)
      )
        throw new Error('Publication input identity changed')
      if (
        source.expected &&
        (!sameIdentity(before, source.expected.identity) || before.size !== source.expected.size)
      )
        throw new Error('Publication input identity or size mismatch')
      const hash = createHash('sha256')
      let size = 0
      for (;;) {
        // Read one extra byte at most to detect growth, without unbounded reads on a live writer.
        const length = Math.min(buffer.length, before.size - size + 1)
        const { bytesRead } = await checked(file.read(buffer, 0, length, null), check)
        if (!bytesRead) break
        size += bytesRead
        if (size > before.size) throw new Error('Publication input grew during copy')
        const bytes = buffer.subarray(0, bytesRead)
        hash.update(bytes)
        for (const output of outputs) {
          await writeAll(output.file, bytes, check)
          output.hash?.update(bytes)
        }
        await checked(turn(), check)
      }
      const sha256 = hash.digest('hex')
      const finish = snapshot(await checked(file.stat({ bigint: true }), check))
      const current = await checked(lstat(source.path, { bigint: true }), check)
      if (
        size !== before.size ||
        !current.isFile() ||
        !sameSnapshot(before, finish) ||
        !sameSnapshot(before, snapshot(current)) ||
        (source.expected && sha256 !== source.expected.sha256)
      )
        throw new Error('Publication input changed or hash mismatch')
      return { sha256, size, sourceSnapshot: before }
    }
  )
}

/**
 * Prepare durable private images only. Unwired until the owner inventories owner.json and
 * fences recovery/erasure against these jobs. Does not create a working-copy manifest, commit
 * marker, receipt or final working file; existing commit/rollback semantics belong to the owner.
 */
export async function prepareArtifactPublicationFiles(
  options: PrepareArtifactPublicationFilesOptions
): Promise<PreparedArtifactPublicationFiles> {
  const { taskId, conversationId, operationId, intentHash } = options.owner
  const owner = { taskId, conversationId, operationId, intentHash },
    source = { ...options.source, identity: { ...options.source.identity } },
    dataDir = resolve(options.dataDir),
    append = options.append === true,
    signal = options.signal,
    assertCurrent = options.assertCurrent
  const previous = options.previous && {
    ...options.previous,
    expected: options.previous.expected && {
      ...options.previous.expected,
      identity: { ...options.previous.expected.identity }
    }
  }
  const jobId = options.jobId ?? randomUUID(),
    root = workingCopyJournalDir(dataDir),
    directory = join(root, jobId)
  if (
    !UUID.test(jobId) ||
    !isPathSafeId(owner.taskId) ||
    !boundedId(owner.conversationId, 500) ||
    !boundedId(owner.operationId, 200) ||
    !SHA256.test(owner.intentHash)
  )
    throw new Error('Invalid publication preparation owner')
  validateSource(source)
  if (previous?.expected) validateSource(previous.expected)
  const check = () => {
    signal?.throwIfAborted()
    assertCurrent?.()
  }
  const ownershipFile = join(directory, 'owner.json')
  const header = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'artifact-publication-preparing',
      ...owner,
      jobId,
      cleanupToken: randomUUID()
    })
  )
  let created: PublicationFileIdentity | undefined,
    headerReady = false,
    claim: string | undefined,
    headerRetired = false,
    directoryRemoved = false
  let terminal: CleanupResult | undefined

  async function owns(path: string): Promise<boolean> {
    let info: BigIntStats
    try {
      info = await lstat(path, { bigint: true })
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
    if (!info.isDirectory() || !created || !sameIdentity(identity(info), created)) return false
    // Before durable ownership or after durable body removal, only an empty/metadata-only job remains.
    if (!headerReady || headerRetired) return true
    return usingFile(
      join(path, 'owner.json'),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      noCheck,
      async (file) => {
        const metadata = await file.stat()
        if (!metadata.isFile() || metadata.size !== header.length) return false
        const bytes = Buffer.alloc(header.length)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null)
          if (!bytesRead) return false
          offset += bytesRead
        }
        return bytes.equals(header)
      }
    ).catch((error) => {
      if (missing(error)) return false
      throw error
    })
  }

  async function absentOrReplaced(path: string): Promise<CleanupResult> {
    try {
      await lstat(path)
      return 'replaced'
    } catch (error) {
      if (missing(error)) return 'absent'
      throw error
    }
  }

  async function assertPrivateImages(path: string): Promise<void> {
    const entries = await readdir(path)
    if (entries.some((entry) => !['owner.json', 'before', 'after'].includes(entry)))
      throw new Error('Publication images have been adopted; cleanup belongs to the journal owner')
  }

  // Caller holds both the original and claimed path locks. On every retry revalidate ownership;
  // a previous native failure never grants permission to remove whatever later reused the name.
  async function cleanupClaim(): Promise<CleanupResult> {
    if (directoryRemoved) {
      await syncDirectory(root, noCheck)
      return (terminal = 'removed')
    }
    const path = claim!
    if (!(await owns(path))) return (terminal = await absentOrReplaced(path))
    await assertPrivateImages(path)
    await syncDirectory(root, noCheck) // Make the claimed ownership location durable first.
    await rm(join(path, 'before'), { force: true })
    await rm(join(path, 'after'), { force: true })
    await syncDirectory(path, noCheck) // Keep durable attribution until every body is durably gone.
    headerRetired = true
    await rm(join(path, 'owner.json'), { force: true })
    await rmdir(path)
    directoryRemoved = true
    await syncDirectory(root, noCheck)
    return (terminal = 'removed')
  }

  async function cleanupOwned(): Promise<CleanupResult> {
    if (terminal) return terminal
    if (claim) return withPath(claim, cleanupClaim)
    if (!(await owns(directory))) return (terminal = await absentOrReplaced(directory))
    // Adoption may have attached a DB commit marker to this UUID; never rename that journal.
    await assertPrivateImages(directory)
    // Never remove a reusable original path. Claim its inode at an unoccupied private UUID,
    // serialized with other helpers that might create that name. No recursive removal can erase
    // owner.json first and leave unattributable body bytes when native cleanup fails partway.
    for (;;) {
      const target = join(root, randomUUID())
      const result = await withPath(target, async () => {
        try {
          await lstat(target)
          return undefined
        } catch (error) {
          if (!missing(error)) throw error
        }
        await rename(directory, target)
        claim = target
        return cleanupClaim()
      })
      if (result !== undefined) return result
    }
  }

  return withPath(directory, async () => {
    check()
    await checked(mkdir(root, { recursive: true, mode: 0o700 }), check)
    // Exclusive creation: an EEXIST must never authorize cleanup of the existing job.
    await mkdir(directory, { mode: 0o700 })
    try {
      const info = await lstat(directory, { bigint: true })
      created = identity(info)
      check()
      await usingFile(ownershipFile, 'wx', check, async (file) => {
        await writeAll(file, header, check)
        await checked(file.sync(), check)
      })
      headerReady = true
      await syncDirectory(directory, check)
      await syncDirectory(root, check)
      await syncDirectory(join(root, '..'), check)
      await syncDirectory(dataDir, check)
      const buffer = Buffer.allocUnsafe(BUFFER_BYTES),
        afterPath = join(directory, 'after'),
        beforePath = join(directory, 'before')
      const afterHash = createHash('sha256')
      const { after, before, sourceSnapshot } = await usingFile(
        afterPath,
        'wx',
        check,
        async (file) => {
          let before: PreparedArtifactPublicationFiles['before'] = null
          if (previous) {
            // Missing initially means no before image; observed disappearance is a conflict.
            const copied = await usingFile(beforePath, 'wx', check, async (beforeFile) => {
              const value = await copyVerified(
                previous,
                [{ file: beforeFile }, ...(append ? [{ file, hash: afterHash }] : [])],
                buffer,
                check,
                true
              )
              if (value) await checked(beforeFile.sync(), check)
              return value
            })
            if (copied) before = { path: beforePath, ...copied }
            else await checked(rm(beforePath), check)
          }
          const value = await copyVerified(
            { path: source.path, expected: source },
            [{ file, hash: afterHash }],
            buffer,
            check
          )
          await checked(file.sync(), check)
          return {
            before,
            sourceSnapshot: value!.sourceSnapshot,
            after: {
              path: afterPath,
              sha256: afterHash.digest('hex'),
              size: (append ? (before?.size ?? 0) : 0) + value!.size
            }
          }
        }
      )
      await syncDirectory(directory, check)
      // A source path/working file can change while later file flushes are pending. Refuse a
      // stale preparation; the owner must revalidate these snapshots again at its publish fence.
      const currentSource = await checked(lstat(source.path, { bigint: true }), check)
      if (!currentSource.isFile() || !sameSnapshot(sourceSnapshot, snapshot(currentSource)))
        throw new Error('Publication source replaced during preparation')
      if (previous) {
        let currentPrevious: BigIntStats | undefined
        try {
          currentPrevious = await checked(lstat(previous.path, { bigint: true }), check)
        } catch (error) {
          if (!missing(error)) throw error
          check()
        }
        if (
          before
            ? !currentPrevious?.isFile() ||
              !sameSnapshot(before.sourceSnapshot, snapshot(currentPrevious))
            : currentPrevious
        )
          throw new Error('Publication previous image changed during preparation')
      }
      check()
      return {
        jobId,
        directory,
        ownershipFile,
        source: { sha256: source.sha256, size: source.size, identity: source.identity },
        before,
        after,
        cleanup: () => withPath(directory, cleanupOwned)
      }
    } catch (error) {
      if (!created) throw error // No content was opened before directory identity was captured.
      try {
        if ((await cleanupOwned()) === 'replaced')
          throw new Error('Publication cleanup lost directory ownership')
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Publication preparation and cleanup failed',
          { cause: error }
        )
      }
      throw error
    }
  })
}
