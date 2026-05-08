import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { readFile, stat as fsStat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  DEFAULT_MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_CHUNK_BYTES,
  UPLOAD_TTL_MS,
  type PreflightResponse,
  type UploadAppendInput,
} from '../shared'

const ACTIVE_LIMIT = 1

interface UploadState {
  uploadId: string
  dir: string
  archivePath: string
  expectedNextSeq: number
  bytesWritten: number
  startedAt: number
}

const states = new Map<string, UploadState>()

function migrationsTmpDir(dataRoot: string): string {
  return join(dataRoot, 'migrations-tmp')
}

function uploadDir(dataRoot: string, uploadId: string): string {
  return join(migrationsTmpDir(dataRoot), uploadId)
}

export function archivePath(dataRoot: string, uploadId: string): string {
  return join(uploadDir(dataRoot, uploadId), 'archive.tar')
}

export function unpackedDir(dataRoot: string, uploadId: string): string {
  return join(uploadDir(dataRoot, uploadId), 'unpacked')
}

export function preflight(opts: {
  dataRoot: string
  maxChunkBytes?: number
  maxArchiveBytes?: number
}): PreflightResponse {
  pruneStale()
  if (states.size >= ACTIVE_LIMIT) {
    throw new Error(
      'A migration upload is already in progress on this server. Wait for it to finish or cancel via TTL.',
    )
  }
  const uploadId = randomUUID()
  const dir = uploadDir(opts.dataRoot, uploadId)
  mkdirSync(dir, { recursive: true })
  states.set(uploadId, {
    uploadId,
    dir,
    archivePath: archivePath(opts.dataRoot, uploadId),
    expectedNextSeq: 0,
    bytesWritten: 0,
    startedAt: Date.now(),
  })
  return {
    uploadId,
    maxChunkBytes: opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES,
    maxArchiveBytes: opts.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
  }
}

export async function appendChunk(input: UploadAppendInput, maxArchiveBytes: number): Promise<void> {
  const state = states.get(input.uploadId)
  if (!state) throw new Error(`Unknown uploadId: ${input.uploadId}`)
  if (input.seq !== state.expectedNextSeq) {
    throw new Error(
      `Out-of-order chunk: expected seq ${state.expectedNextSeq}, got ${input.seq}`,
    )
  }
  const decoded = Buffer.from(input.data, 'base64')
  const computed = createHash('sha256').update(decoded).digest('hex')
  if (computed !== input.sha256) {
    throw new Error(`sha256 mismatch on chunk ${input.seq}`)
  }
  if (state.bytesWritten + decoded.byteLength > maxArchiveBytes) {
    throw new Error(
      `Archive size limit exceeded: ${state.bytesWritten + decoded.byteLength} > ${maxArchiveBytes}`,
    )
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(state.archivePath, { flags: 'a' })
    stream.on('error', reject)
    stream.on('finish', resolve)
    stream.end(decoded)
  })
  state.bytesWritten += decoded.byteLength
  state.expectedNextSeq += 1
}

export async function verifyArchive(uploadId: string, expectedSha: string, expectedBytes: number): Promise<void> {
  const state = states.get(uploadId)
  if (!state) throw new Error(`Unknown uploadId: ${uploadId}`)
  const stat = await fsStat(state.archivePath)
  if (stat.size !== expectedBytes) {
    throw new Error(
      `Archive byte length mismatch: on-disk ${stat.size} vs declared ${expectedBytes}`,
    )
  }
  const data = await readFile(state.archivePath)
  const sha = createHash('sha256').update(data).digest('hex')
  if (sha !== expectedSha) {
    throw new Error('Archive sha256 mismatch')
  }
}

export function getUploadDir(uploadId: string): string {
  const state = states.get(uploadId)
  if (!state) throw new Error(`Unknown uploadId: ${uploadId}`)
  return state.dir
}

export function discardUpload(uploadId: string): void {
  const state = states.get(uploadId)
  if (!state) return
  try {
    if (existsSync(state.dir)) rmSync(state.dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  states.delete(uploadId)
}

export function pruneStale(): void {
  const now = Date.now()
  for (const [id, state] of states) {
    if (now - state.startedAt > UPLOAD_TTL_MS) {
      discardUpload(id)
    }
  }
}

/** Boot-time scan: removes any leftover migrations-tmp/ dirs older than TTL. */
export function gcMigrationsTmp(dataRoot: string): void {
  const root = migrationsTmpDir(dataRoot)
  if (!existsSync(root)) return
  const cutoff = Date.now() - UPLOAD_TTL_MS
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const name of entries) {
    const sub = join(root, name)
    try {
      const stat = statSync(sub)
      if (stat.mtimeMs < cutoff) rmSync(sub, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

export function activeUploadCount(): number {
  return states.size
}
