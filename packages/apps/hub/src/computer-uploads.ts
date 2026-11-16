/**
 * Bytes the hub sends to a computer for an upload (an artifact, a content write, an
 * attachment) — FU1 S3.
 *
 * To a computer that answers bounded reads (`boundedReads`): staged in chunks
 * (`upload.begin` / `upload.chunk`, ≤ 256 KiB each — one frame apiece), resumed
 * from what it already holds, and named by hash in the upload ({ staged }). Any
 * size, read from a file without holding it whole.
 *
 * To an older computer: inline base64 ({ data }), as before, up to the 14,000,000
 * chars its request schemas accept. Over that the hub refuses BEFORE encoding, as
 * a refused oversized frame (REST 413, tRPC PAYLOAD_TOO_LARGE) — the computer would
 * have refused it anyway, after the hub encoded and sent all of it.
 *
 * @module hub/computer-uploads
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { COMPUTER_FRAME_TOO_LARGE_RPC_CODE } from '@slayzone/platform/computer-frame-limit'

/** Base64 chars an older computer accepts in one upload request. */
export const INLINE_UPLOAD_MAX_CHARS = 14_000_000

export type UploadSource = Uint8Array | { path: string }
interface UploadOptions {
  bounded: boolean
  send: (body: unknown) => Promise<unknown>
  source: UploadSource
  owner?: { route: { id: string; epoch: number }; operationId?: string }
}
export type UploadBytes =
  | { staged: { sha256: string; size: number; uploadId?: string } }
  | { data: string }

/** Base64 length of `bytes` bytes. */
const base64Chars = (bytes: number) => Math.ceil(bytes / 3) * 4

function tooLargeForComputer(size: number): Error {
  return Object.assign(
    new Error(
      `upload of ${size} bytes (${base64Chars(size)} base64 chars) is over the ` +
        `${INLINE_UPLOAD_MAX_CHARS} chars this computer accepts in one request; ` +
        'update SlayZone on that computer to send it in parts'
    ),
    { name: 'RpcError', code: COMPUTER_FRAME_TOO_LARGE_RPC_CODE }
  )
}

/** The source's size, and its ranges in order from `from` (a file is read range by range). */
async function sizeOf(source: UploadSource): Promise<number> {
  return source instanceof Uint8Array ? source.length : (await stat(source.path)).size
}

async function* rangesOf(source: UploadSource, from: number): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    for (let o = from; o < source.length; o += BYTE_RANGE_MAX_CHUNK)
      yield source.subarray(o, o + BYTE_RANGE_MAX_CHUNK)
    return
  }
  const fd = await open(source.path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(BYTE_RANGE_MAX_CHUNK)
    for (let o = from; ; ) {
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, o)
      if (bytesRead === 0) return
      yield Buffer.from(buffer.subarray(0, bytesRead))
      o += bytesRead
    }
  } finally {
    await fd.close()
  }
}

async function sha256Of(source: UploadSource): Promise<string> {
  const h = createHash('sha256')
  for await (const part of rangesOf(source, 0)) h.update(part)
  return h.digest('hex')
}

/**
 * `source`'s bytes for one upload request to a computer: staged (`bounded`) or
 * inline. `send` is the request transport of the caller (the upload goes the same way).
 */
export async function uploadBytesFor(opts: UploadOptions): Promise<UploadBytes> {
  const size = await sizeOf(opts.source)
  if (!opts.bounded) {
    if (base64Chars(size) > INLINE_UPLOAD_MAX_CHARS) throw tooLargeForComputer(size)
    const bytes = opts.source instanceof Uint8Array ? opts.source : readFileSync(opts.source.path)
    return { data: Buffer.from(bytes).toString('base64') }
  }
  const sha256 = await sha256Of(opts.source)
  return stageBytes(opts, { sha256, size })
}

async function stageBytes(
  opts: UploadOptions,
  { sha256, size }: { sha256: string; size: number },
  owned?: () => void
): Promise<UploadBytes> {
  const owner = opts.owner
    ? { ...opts.owner, operationId: opts.owner.operationId ?? randomUUID() }
    : undefined
  const { received, uploadId } = (await opts.send({
    kind: 'upload.begin',
    sha256,
    size,
    ...(owner ? { route: owner.route, operationId: owner.operationId } : {})
  })) as {
    received: number
    uploadId?: string
  }
  if (
    !Number.isSafeInteger(received) ||
    received < 0 ||
    received > size ||
    (uploadId !== undefined && (!owner || !/^[a-f0-9]{64}$/.test(uploadId)))
  )
    throw new Error('Invalid upload checkpoint')
  if (uploadId) owned?.()
  let offset = received
  for await (const part of rangesOf(opts.source, received)) {
    await opts.send({
      kind: 'upload.chunk',
      sha256,
      size,
      offset,
      ...(uploadId ? { uploadId, route: owner!.route } : {}),
      data: Buffer.from(part).toString('base64')
    })
    offset += part.length
  }
  return { staged: { sha256, size, ...(uploadId ? { uploadId } : {}) } }
}

const pending = new Map<string, Promise<void>>()
/** Keep a legacy receiver's shared hash slot locked THROUGH consumption. Owned acknowledgements release it early. */
export async function withUploadedBytes<T>(
  opts: UploadOptions & { computerId: string },
  consume: (bytes: UploadBytes) => Promise<T>
): Promise<T> {
  if (!opts.bounded) return consume(await uploadBytesFor(opts))
  const prepared = { size: await sizeOf(opts.source), sha256: await sha256Of(opts.source) }
  const key = JSON.stringify([opts.computerId, prepared.sha256, prepared.size])
  const previous = pending.get(key) ?? Promise.resolve()
  let resolve!: () => void
  const held = new Promise<void>((done) => {
    resolve = done
  })
  const queued = previous.then(() => held)
  pending.set(key, queued)
  await previous
  let released = false
  const release = () => {
    if (released) return
    released = true
    resolve()
    if (pending.get(key) === queued) pending.delete(key)
  }
  try {
    return await consume(await stageBytes(opts, prepared, release))
  } finally {
    release()
  }
}
