import { createPatch, structuredPatch } from 'diff'
import { BlobStore } from './blob-store'
import type { DbLike } from './db'
import { getCurrentVersion, resolveVersionRef } from './resolve'
import type { ArtifactId, ContentHash, DiffHunk, DiffResult, VersionRef } from '../shared/types'
import { VersionError } from './errors'

export interface DiffInput {
  artifactId: ArtifactId | string
  a: VersionRef
  b?: VersionRef
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(8000, buf.length))
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true
  }
  return false
}

export function diffVersions(db: DbLike, blobStore: BlobStore, input: DiffInput): DiffResult {
  const verA = resolveVersionRef(db, input.artifactId, input.a)
  const verB = input.b !== undefined
    ? resolveVersionRef(db, input.artifactId, input.b)
    : getCurrentVersion(db, input.artifactId)
  if (!verB) {
    throw new VersionError('NOT_FOUND', 'No current version to compare against', {
      artifactId: input.artifactId,
    })
  }

  if (verA.content_hash === verB.content_hash) {
    return { kind: 'text', hunks: [] }
  }

  const bufA = blobStore.read(verA.content_hash)
  const bufB = blobStore.read(verB.content_hash)

  if (isBinary(bufA) || isBinary(bufB)) {
    return {
      kind: 'binary',
      a: { hash: verA.content_hash as ContentHash, size: verA.size },
      b: { hash: verB.content_hash as ContentHash, size: verB.size },
    }
  }

  const patch = structuredPatch(
    `v${verA.version_num}`,
    `v${verB.version_num}`,
    bufA.toString('utf-8'),
    bufB.toString('utf-8'),
    '',
    '',
    { context: 3 }
  )

  const hunks: DiffHunk[] = patch.hunks.map((h) => ({
    lines: h.lines.map((line) => {
      const prefix = line.charAt(0)
      const text = line.slice(1)
      if (prefix === '+') return { kind: 'add' as const, text }
      if (prefix === '-') return { kind: 'del' as const, text }
      return { kind: 'ctx' as const, text }
    }),
  }))

  return { kind: 'text', hunks }
}

export function diffUnified(db: DbLike, blobStore: BlobStore, input: DiffInput): string {
  const verA = resolveVersionRef(db, input.artifactId, input.a)
  const verB = input.b !== undefined
    ? resolveVersionRef(db, input.artifactId, input.b)
    : getCurrentVersion(db, input.artifactId)
  if (!verB) {
    throw new VersionError('NOT_FOUND', 'No current version to compare against', {
      artifactId: input.artifactId,
    })
  }
  const bufA = blobStore.read(verA.content_hash)
  const bufB = blobStore.read(verB.content_hash)
  return createPatch(
    'artifact',
    bufA.toString('utf-8'),
    bufB.toString('utf-8'),
    `v${verA.version_num}`,
    `v${verB.version_num}`
  )
}
