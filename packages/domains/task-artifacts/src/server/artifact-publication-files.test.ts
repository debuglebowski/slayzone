import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'
import { afterEach, expect, test, vi } from 'vitest'
import {
  prepareArtifactPublicationFiles,
  type PublicationSourceFile
} from './artifact-publication-files'

const roots: string[] = []
const unlocks: Array<() => void> = []
afterEach(async () => {
  for (const unlock of unlocks.splice(0)) unlock()
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const owner = {
  taskId: 'task-a',
  conversationId: 'conversation-a',
  operationId: 'operation-a',
  intentHash: 'a'.repeat(64)
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-prepare-'))
  roots.push(root)
  const handle = await open(join(root, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  return { root, prototype }
}
async function pattern(path: string, size: number, seed = 19): Promise<PublicationSourceFile> {
  const file = await open(path, 'wx')
  const hash = createHash('sha256'),
    chunk = Buffer.alloc(64 * 1024)
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + seed) % 256
  Buffer.from('x😀é\0\r\n').copy(chunk)
  try {
    for (let offset = 0; offset < size; ) {
      const body = chunk.subarray(0, Math.min(chunk.length, size - offset))
      let written = 0
      while (written < body.length)
        written += (await file.write(body, written, body.length - written)).bytesWritten
      hash.update(body)
      offset += body.length
    }
  } finally {
    await file.close()
  }
  const identity = await stat(path, { bigint: true })
  return {
    path,
    size,
    sha256: hash.digest('hex'),
    identity: { dev: String(identity.dev), ino: String(identity.ino) }
  }
}
async function hashFiles(...paths: string[]) {
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(64 * 1024)
  let size = 0
  for (const path of paths) {
    const file = await open(path, 'r')
    try {
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
        size += bytesRead
      }
    } finally {
      await file.close()
    }
  }
  return { sha256: hash.digest('hex'), size }
}
async function children(root: string) {
  try {
    return await readdir(join(root, 'artifacts', '.transactions'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
function block() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  unlocks.push(release)
  return { wait, release }
}

// All expectations are real file bytes/hashes/lifetimes, not the chosen buffer constant.
test('large binary append preserves the previous image, exact bytes and bounded allocation/read/write work', async () => {
  const { root, prototype } = await setup()
  const source = await pattern(join(root, 'source'), 32 * 1024 * 1024 + 17)
  const previous = await pattern(join(root, 'previous'), 4 * 1024 * 1024 + 101, 7)
  const expected = await hashFiles(previous.path, source.path)
  const read = prototype.read,
    write = prototype.write
  let readBytes = 0,
    maxRead = 0,
    maxWrite = 0
  vi.spyOn(prototype, 'read').mockImplementation(async function (
    this: FileHandle,
    ...args: unknown[]
  ) {
    const requested = args[2] as number
    maxRead = Math.max(maxRead, requested)
    const result = (await Reflect.apply(read, this, args)) as { bytesRead: number; buffer: Buffer }
    readBytes += result.bytesRead
    return result
  })
  vi.spyOn(prototype, 'write').mockImplementation(async function (
    this: FileHandle,
    ...args: unknown[]
  ) {
    maxWrite = Math.max(maxWrite, args[2] as number)
    return Reflect.apply(write, this, args)
  })
  for (const name of ['readFile', 'writeFile'] as const)
    vi.spyOn(prototype, name).mockImplementation(() => {
      throw new Error('whole-file API is forbidden')
    })
  const alloc = Buffer.alloc,
    unsafe = Buffer.allocUnsafe,
    slow = Buffer.allocUnsafeSlow,
    concat = Buffer.concat
  vi.spyOn(Buffer, 'alloc').mockImplementation(((n: number, ...args: unknown[]) => {
    if (n > 256 * 1024) throw new Error('whole-file allocation')
    return Reflect.apply(alloc, Buffer, [n, ...args])
  }) as typeof Buffer.alloc)
  vi.spyOn(Buffer, 'allocUnsafe').mockImplementation(((n: number) => {
    if (n > 256 * 1024) throw new Error('whole-file allocation')
    return unsafe(n)
  }) as typeof Buffer.allocUnsafe)
  vi.spyOn(Buffer, 'allocUnsafeSlow').mockImplementation((n: number) => {
    if (n > 256 * 1024) throw new Error('whole-file allocation')
    return slow(n)
  })
  vi.spyOn(Buffer, 'concat').mockImplementation((list, total) => {
    if ((total ?? list.reduce((n, b) => n + b.length, 0)) > 256 * 1024)
      throw new Error('whole-file concat')
    return concat(list, total)
  })
  const syncRead = fs.readFileSync,
    syncWrite = fs.writeFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation(((
    path: fs.PathOrFileDescriptor,
    ...args: unknown[]
  ) => {
    if (typeof path === 'string' && path.startsWith(root)) throw new Error('synchronous file read')
    return Reflect.apply(syncRead, fs, [path, ...args])
  }) as typeof fs.readFileSync)
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((
    path: fs.PathOrFileDescriptor,
    ...args: unknown[]
  ) => {
    if (typeof path === 'string' && path.startsWith(root)) throw new Error('synchronous file write')
    return Reflect.apply(syncWrite, fs, [path, ...args])
  }) as typeof fs.writeFileSync)
  for (const method of ['readSync', 'writeSync', 'fsyncSync', 'copyFileSync'] as const)
    vi.spyOn(fs, method).mockImplementation(() => {
      throw new Error('synchronous content I/O')
    })
  syncBuiltinESMExports()
  const files = await prepareArtifactPublicationFiles({
    dataDir: root,
    owner,
    source,
    previous: { path: previous.path },
    append: true
  })
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  expect(readBytes).toBeGreaterThanOrEqual(source.size + previous.size)
  expect(maxRead).toBeLessThanOrEqual(256 * 1024)
  expect(maxWrite).toBeLessThanOrEqual(256 * 1024)
  expect(await hashFiles(files.after.path)).toEqual(expected)
  expect(await hashFiles(files.before!.path)).toEqual({
    sha256: previous.sha256,
    size: previous.size
  })
  expect(files.after).toMatchObject(expected)
  expect(files.source).toMatchObject({ sha256: source.sha256, size: source.size })
  expect(await hashFiles(source.path)).toEqual({ sha256: source.sha256, size: source.size })
  expect(await files.cleanup()).toBe('removed')
  expect(await children(root)).toEqual([])
})

test.each([0, 1, 256 * 1024 - 1, 256 * 1024 + 1])(
  'replace is byte-exact, including empty/boundary source (%s)',
  async (size) => {
    const { root } = await setup()
    const source = await pattern(join(root, 'source'), size)
    const previous = await pattern(join(root, 'previous'), 999)
    const files = await prepareArtifactPublicationFiles({
      dataDir: root,
      owner,
      source,
      previous: { path: previous.path }
    })
    expect(await hashFiles(files.after.path)).toEqual({ sha256: source.sha256, size })
    expect(await hashFiles(files.before!.path)).toEqual({
      sha256: previous.sha256,
      size: previous.size
    })
    await files.cleanup()
  }
)

test('missing previous is empty for append; arbitrary unsaved working bytes are preserved, not compared to a version hash', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 1001)
  const missing = await prepareArtifactPublicationFiles({
    dataDir: root,
    owner,
    source,
    previous: { path: join(root, 'missing') },
    append: true
  })
  expect(missing.before).toBeNull()
  expect(await hashFiles(missing.after.path)).toEqual({ sha256: source.sha256, size: source.size })
  await missing.cleanup()
  await writeFile(join(root, 'unsaved'), Buffer.from([0xff, 0, 0xfe, 13, 10]))
  const files = await prepareArtifactPublicationFiles({
    dataDir: root,
    owner,
    source,
    previous: { path: join(root, 'unsaved') },
    append: true
  })
  expect(await readFile(files.before!.path)).toEqual(Buffer.from([0xff, 0, 0xfe, 13, 10]))
  expect(await hashFiles(files.after.path)).toEqual(
    await hashFiles(join(root, 'unsaved'), source.path)
  )
  await files.cleanup()
})

test('partial native reads and writes make progress without dropping or duplicating bytes', async () => {
  const { root, prototype } = await setup()
  const source = await pattern(join(root, 'source'), 600_001)
  const read = prototype.read,
    write = prototype.write
  for (const [method, original] of [
    ['read', read],
    ['write', write]
  ] as const)
    vi.spyOn(prototype, method).mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ) {
      args[2] = Math.min(args[2] as number, 17003)
      return Reflect.apply(original, this, args)
    })
  const files = await prepareArtifactPublicationFiles({ dataDir: root, owner, source })
  vi.restoreAllMocks()
  expect(await hashFiles(files.after.path)).toEqual({ sha256: source.sha256, size: source.size })
  await files.cleanup()
})

test('attributable owner metadata and its directory are synced before the first source read', async () => {
  const { root, prototype } = await setup()
  const source = await pattern(join(root, 'source'), 600_000)
  const sync = prototype.sync,
    read = prototype.read
  let ownerSynced = false,
    jobDirectorySynced = false,
    observed = false
  vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
    const info = await this.stat()
    await sync.call(this)
    if (info.isDirectory()) jobDirectorySynced = true
    else if (info.size > 100 && info.size < 16 * 1024) ownerSynced = true
  })
  vi.spyOn(prototype, 'read').mockImplementation(async function (
    this: FileHandle,
    ...args: unknown[]
  ) {
    if (!observed) {
      observed = true
      expect(ownerSynced).toBe(true)
      if (process.platform !== 'win32') expect(jobDirectorySynced).toBe(true)
      const [job] = await children(root)
      const header = JSON.parse(
        await readFile(join(root, 'artifacts', '.transactions', job, 'owner.json'), 'utf8')
      )
      expect(header).toMatchObject({ version: 1, kind: 'artifact-publication-preparing', ...owner })
    }
    return Reflect.apply(read, this, args)
  })
  const files = await prepareArtifactPublicationFiles({ dataDir: root, owner, source })
  vi.restoreAllMocks()
  expect(observed).toBe(true)
  await files.cleanup()
})

test.each(['read', 'sync'] as const)(
  'delayed native %s keeps acknowledgement pending while control turns and unrelated jobs progress',
  async (method) => {
    const { root, prototype } = await setup()
    const source = await pattern(join(root, 'source'), 2 * 1024 * 1024)
    const other = await pattern(join(root, 'other'), 101)
    const original = prototype[method],
      gate = block()
    let entered = false,
      done = false
    vi.spyOn(prototype, method).mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ) {
      if (!entered && (await this.stat()).size === source.size) {
        entered = true
        await gate.wait
      }
      return Reflect.apply(original, this, args)
    })
    const pending = prepareArtifactPublicationFiles({ dataDir: root, owner, source }).then(
      (value) => {
        done = true
        return value
      }
    )
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      await turn()
      expect(done).toBe(false)
      const independent = await prepareArtifactPublicationFiles({
        dataDir: root,
        owner: { ...owner, taskId: 'task-b' },
        source: other
      })
      await independent.cleanup()
      expect(done).toBe(false)
    } finally {
      gate.release()
    }
    const files = await pending
    vi.restoreAllMocks()
    await files.cleanup()
  }
)

test.each(['hash', 'size', 'identity', 'truncate', 'replace', 'cancel', 'lifecycle'] as const)(
  '%s refuses source publication and cleans only owned preparation',
  async (failure) => {
    const { root, prototype } = await setup()
    const source = await pattern(join(root, 'source'), 600_001)
    if (failure === 'hash') source.sha256 = '0'.repeat(64)
    if (failure === 'size') source.size++
    if (failure === 'identity') source.identity.ino += '0'
    const gate = block(),
      read = prototype.read,
      abort = new AbortController()
    let entered = false,
      stale = false
    const delayed = ['truncate', 'replace', 'cancel', 'lifecycle'].includes(failure)
    if (delayed)
      vi.spyOn(prototype, 'read').mockImplementationOnce(async function (
        this: FileHandle,
        ...args: unknown[]
      ) {
        entered = true
        await gate.wait
        return Reflect.apply(read, this, args)
      })
    const pending = prepareArtifactPublicationFiles({
      dataDir: root,
      owner,
      source,
      signal: abort.signal,
      assertCurrent: () => {
        if (stale) throw new Error('stale lifecycle')
      }
    }).then(
      () => null,
      (error: Error) => error
    )
    try {
      if (delayed) {
        await vi.waitFor(() => expect(entered).toBe(true))
        if (failure === 'truncate') {
          const f = await open(source.path, 'r+')
          await f.truncate(3)
          await f.close()
        }
        if (failure === 'replace') {
          await rename(source.path, source.path + '.old')
          await pattern(source.path, source.size)
        }
        if (failure === 'cancel') abort.abort(new Error('cancelled'))
        if (failure === 'lifecycle') stale = true
      }
    } finally {
      gate.release()
    }
    expect(await pending).toBeInstanceOf(Error)
    vi.restoreAllMocks()
    expect(await children(root)).toEqual([])
    expect((await stat(source.path)).isFile()).toBe(true)
  }
)

test.each(['read', 'write', 'sync', 'close'] as const)(
  'native %s failure rejects, closes remaining descriptors and settles cleanup',
  async (method) => {
    const { root, prototype } = await setup()
    const source = await pattern(join(root, 'source'), 600_000)
    const original = prototype[method]
    let failed = false
    if (method === 'close') {
      const nativeOpen = fs.promises.open
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const file = await Reflect.apply(nativeOpen, fs.promises, args)
        const close = file.close.bind(file)
        file.close = async () => {
          if (!failed && (await file.stat()).isFile()) {
            failed = true
            await close()
            throw Object.assign(new Error('native failure'), { code: 'EIO' })
          }
          await close()
        }
        return file
      })
      syncBuiltinESMExports()
    } else
      vi.spyOn(prototype, method).mockImplementation(async function (
        this: FileHandle,
        ...args: unknown[]
      ) {
        if (!failed && (await this.stat()).isFile()) {
          failed = true
          throw Object.assign(new Error('native failure'), { code: 'EIO' })
        }
        return Reflect.apply(original, this, args)
      })
    await expect(prepareArtifactPublicationFiles({ dataDir: root, owner, source })).rejects.toThrow(
      'native failure'
    )
    vi.restoreAllMocks()
    expect(failed).toBe(true)
    expect(await children(root)).toEqual([])
  }
)

test('unreadable previous file refuses instead of silently appending to an empty prefix', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 1001)
  await mkdir(join(root, 'previous-directory'))
  await expect(
    prepareArtifactPublicationFiles({
      dataDir: root,
      owner,
      source,
      previous: { path: join(root, 'previous-directory') },
      append: true
    })
  ).rejects.toThrow()
  expect(await children(root)).toEqual([])
})

test('cleanup is idempotent and cannot erase a replacement or a concurrently prepared job', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 1001),
    jobId = randomUUID()
  const old = await prepareArtifactPublicationFiles({ dataDir: root, owner, source, jobId })
  const moved = join(root, 'artifacts', '.transactions', randomUUID())
  await rename(old.directory, moved)
  const next = await prepareArtifactPublicationFiles({ dataDir: root, owner, source, jobId })
  expect(await old.cleanup()).toBe('replaced')
  expect(await old.cleanup()).toBe('replaced')
  expect(await hashFiles(next.after.path)).toEqual({ sha256: source.sha256, size: source.size })
  expect(await next.cleanup()).toBe('removed')
  expect(await next.cleanup()).toBe('removed')
  expect((await readdir(moved)).length).toBeGreaterThan(0)
})

test('a caller-observed previous image disappearing is a conflict, not an empty append prefix', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 1001)
  const previous = await pattern(join(root, 'previous'), 701)
  await rm(previous.path)
  await expect(
    prepareArtifactPublicationFiles({
      dataDir: root,
      owner,
      source,
      previous: { path: previous.path, expected: previous },
      append: true
    })
  ).rejects.toThrow()
  expect(await children(root)).toEqual([])
})

test('failed cleanup retains durable attribution for remaining bytes and supports retry', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 1001)
  const files = await prepareArtifactPublicationFiles({ dataDir: root, owner, source })
  const nativeRm = fs.promises.rm
  let failed = false
  vi.spyOn(fs.promises, 'rm').mockImplementation(async (path, options) => {
    if (
      !failed &&
      String(path).includes('.transactions') &&
      (options?.recursive || basename(String(path)) === 'after')
    ) {
      failed = true
      // Recursive native removal may erase the header before failing on the body.
      if (options?.recursive) await nativeRm(join(String(path), 'owner.json'), { force: true })
      throw Object.assign(new Error('cleanup failure'), { code: 'EIO' })
    }
    return nativeRm(path, options)
  })
  syncBuiltinESMExports()
  await expect(files.cleanup()).rejects.toThrow('cleanup failure')
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  const [retained] = await children(root)
  const retainedDirectory = join(root, 'artifacts', '.transactions', retained)
  expect(await hashFiles(join(retainedDirectory, 'after'))).toEqual({
    sha256: source.sha256,
    size: source.size
  })
  expect(JSON.parse(await readFile(join(retainedDirectory, 'owner.json'), 'utf8'))).toMatchObject(
    owner
  )
  expect(await files.cleanup()).toBe('removed')
  expect(await children(root)).toEqual([])
})

test('retry after failed cleanup refuses a replacement at its claimed directory', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 1001)
  const files = await prepareArtifactPublicationFiles({ dataDir: root, owner, source })
  const nativeRm = fs.promises.rm
  vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('cleanup failure'))
  syncBuiltinESMExports()
  await expect(files.cleanup()).rejects.toThrow('cleanup failure')
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  const [claimed] = await children(root)
  await rename(join(root, 'artifacts', '.transactions', claimed), join(root, 'retained-old'))
  const newer = await prepareArtifactPublicationFiles({
    dataDir: root,
    owner,
    source,
    jobId: claimed
  })
  expect(await files.cleanup()).toBe('replaced')
  expect(await hashFiles(newer.after.path)).toEqual({ sha256: source.sha256, size: source.size })
  expect(await newer.cleanup()).toBe('removed')
  expect((await readdir(join(root, 'retained-old'))).length).toBeGreaterThan(0)
  // Ensure the spy's saved real method remains usable independently of module export restoration.
  await nativeRm(join(root, 'retained-old'), { recursive: true })
})

test('cancel waits for the consumed source descriptor to close before cleanup/quiescence', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 600_001)
  const nativeOpen = fs.promises.open,
    gate = block(),
    abort = new AbortController()
  let closing = false,
    done = false
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const file = await Reflect.apply(nativeOpen, fs.promises, args)
    if (String(args[0]) === source.path) {
      const close = file.close.bind(file)
      file.close = async () => {
        closing = true
        await gate.wait
        await close()
      }
    }
    return file
  })
  syncBuiltinESMExports()
  const pending = prepareArtifactPublicationFiles({
    dataDir: root,
    owner,
    source,
    signal: abort.signal
  }).then(
    () => {
      done = true
      return null
    },
    (error) => {
      done = true
      return error
    }
  )
  try {
    await vi.waitFor(() => expect(closing).toBe(true))
    abort.abort(new Error('cancelled'))
    await turn()
    expect(done).toBe(false)
    expect(await children(root)).toHaveLength(1)
  } finally {
    gate.release()
  }
  expect(await pending).toBeInstanceOf(Error)
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  expect(await children(root)).toEqual([])
})

test('concurrent use of an occupied job id never cleans the original preparation', async () => {
  const { root, prototype } = await setup()
  const source = await pattern(join(root, 'source'), 600_001),
    jobId = randomUUID()
  const read = prototype.read,
    gate = block()
  let entered = false
  vi.spyOn(prototype, 'read').mockImplementationOnce(async function (
    this: FileHandle,
    ...args: unknown[]
  ) {
    entered = true
    await gate.wait
    return Reflect.apply(read, this, args)
  })
  const pending = prepareArtifactPublicationFiles({ dataDir: root, owner, source, jobId })
  await vi.waitFor(() => expect(entered).toBe(true))
  const conflict = prepareArtifactPublicationFiles({ dataDir: root, owner, source, jobId }).then(
    () => null,
    (error) => error
  )
  gate.release()
  const files = await pending
  expect(await conflict).toMatchObject({ code: 'EEXIST' })
  vi.restoreAllMocks()
  expect(await hashFiles(files.after.path)).toEqual({ sha256: source.sha256, size: source.size })
  await files.cleanup()
})

test.each(['source-at-flush', 'previous-during-source'] as const)(
  '%s replacement before durable preparation completes is refused',
  async (target) => {
    const { root, prototype } = await setup()
    const source = await pattern(join(root, 'source'), 600_001)
    const previous = await pattern(join(root, 'previous'), 701)
    const method = target === 'source-at-flush' ? 'sync' : 'read'
    const original = prototype[method],
      gate = block()
    let entered = false
    vi.spyOn(prototype, method).mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ) {
      if (
        !entered &&
        (await this.stat()).size ===
          (target === 'source-at-flush' ? source.size + previous.size : source.size)
      ) {
        entered = true
        await gate.wait
      }
      return Reflect.apply(original, this, args)
    })
    const pending = prepareArtifactPublicationFiles({
      dataDir: root,
      owner,
      source,
      previous: { path: previous.path },
      append: true
    }).then(
      () => null,
      (error) => error
    )
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      const replaced = target === 'source-at-flush' ? source : previous
      await rename(replaced.path, replaced.path + '.old')
      await pattern(replaced.path, replaced.size)
    } finally {
      gate.release()
    }
    expect(await pending).toBeInstanceOf(Error)
    vi.restoreAllMocks()
    expect(await children(root)).toEqual([])
  }
)

test('ownership attribution accepts existing non-path operation/conversation ids without using them as filenames', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 701)
  const context = {
    ...owner,
    conversationId: 'c:/é?' + 'c'.repeat(400),
    operationId: 'write:task/é:' + 'o'.repeat(150)
  }
  const files = await prepareArtifactPublicationFiles({ dataDir: root, owner: context, source })
  expect(JSON.parse(await readFile(files.ownershipFile, 'utf8'))).toMatchObject(context)
  expect(await hashFiles(files.after.path)).toEqual({ sha256: source.sha256, size: source.size })
  await files.cleanup()
})

test('source descriptor substitution is refused even when the original path and replacement bytes match', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 701)
  const imposter = await pattern(join(root, 'imposter'), source.size)
  const nativeOpen = fs.promises.open
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === source.path) args[0] = imposter.path
    return Reflect.apply(nativeOpen, fs.promises, args)
  })
  syncBuiltinESMExports()
  await expect(prepareArtifactPublicationFiles({ dataDir: root, owner, source })).rejects.toThrow(
    'identity'
  )
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  expect(await children(root)).toEqual([])
  expect(await hashFiles(source.path)).toEqual({ sha256: source.sha256, size: source.size })
})

test.skipIf(process.platform === 'win32')(
  'cleanup retries the final parent flush before acknowledging durable removal',
  async () => {
    const { root } = await setup()
    const source = await pattern(join(root, 'source'), 701)
    const files = await prepareArtifactPublicationFiles({ dataDir: root, owner, source })
    const nativeOpen = fs.promises.open,
      journalRoot = join(root, 'artifacts', '.transactions')
    let finalFlushes = 0
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const file = await Reflect.apply(nativeOpen, fs.promises, args)
      if (String(args[0]) === journalRoot) {
        const sync = file.sync.bind(file)
        file.sync = async () => {
          if ((await children(root)).length === 0 && ++finalFlushes === 1)
            throw new Error('final parent flush failed')
          await sync()
        }
      }
      return file
    })
    syncBuiltinESMExports()
    await expect(files.cleanup()).rejects.toThrow('final parent flush failed')
    expect(await files.cleanup()).toBe('removed')
    expect(finalFlushes).toBe(2)
  }
)

test('cleanup refuses an adopted journal before changing its commit-marker directory identity', async () => {
  const { root } = await setup()
  const source = await pattern(join(root, 'source'), 701)
  const files = await prepareArtifactPublicationFiles({ dataDir: root, owner, source })
  const manifest = {
    taskId: owner.taskId,
    artifactId: 'artifact-a',
    previousTitle: 'a.txt',
    title: 'a.txt',
    hadOriginal: false,
    sequence: 7
  }
  await writeFile(join(files.directory, 'manifest.json'), JSON.stringify(manifest))
  await expect(files.cleanup()).rejects.toThrow('adopted')
  expect(await children(root)).toEqual([files.jobId])
  expect(JSON.parse(await readFile(join(files.directory, 'manifest.json'), 'utf8'))).toEqual(
    manifest
  )
  expect(await hashFiles(files.after.path)).toEqual({ sha256: source.sha256, size: source.size })
})
