import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  fsyncSync,
  constants
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isPathSafeId } from '@slayzone/platform/safe-path'
import { listQuarantine } from '@slayzone/platform/quarantine'

/** Unknown preparing bytes remain unknown after recovery moves them aside. */
export function assertNoUnattributedArtifactPreparations(root: string): void {
  if (
    listQuarantine(root).some(
      (entry) =>
        entry.pass === 'artifact-file-journal' &&
        entry.meta?.reason.includes('Unattributed artifact preparation')
    )
  )
    throw new Error('Unattributed artifact preparation requires ownership review')
}

/** Retire attribution only after every private body is durably gone. */
export function removeArtifactJournal(dir: string, remove: (path: string) => void): void {
  const sync = (path: string) => {
    if (process.platform === 'win32') return
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  const erase = (path: string) => {
    remove(path)
    if (existsSync(path)) throw new Error('Artifact journal body remains')
  }
  for (const entry of readdirSync(dir))
    if (!['owner.json', 'manifest.json', 'manifest.tmp'].includes(entry)) erase(join(dir, entry))
  sync(dir)
  for (const entry of ['manifest.tmp', 'manifest.json', 'owner.json']) erase(join(dir, entry))
  erase(dir)
  sync(dirname(dir))
}

/** Preparing images and cleanup claims retain the original UUID in their durable owner. */
export function readArtifactPreparationOwner(
  dir: string
): { taskId: string; artifactId?: string } | null {
  const path = join(dir, 'owner.json')
  if (!existsSync(path)) return null
  const owner = readJournalJson(path)
  if (
    owner?.version !== 1 ||
    owner.kind !== 'artifact-publication-preparing' ||
    !isPathSafeId(owner.taskId) ||
    (owner.artifactId !== undefined && !isPathSafeId(owner.artifactId)) ||
    typeof owner.conversationId !== 'string' ||
    !owner.conversationId.length ||
    owner.conversationId.length > 500 ||
    typeof owner.operationId !== 'string' ||
    !owner.operationId.length ||
    owner.operationId.length > 200 ||
    !/^[a-f0-9]{64}$/.test(owner.intentHash) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner.jobId) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner.cleanupToken)
  )
    throw new Error('Unattributed artifact preparation owner')
  return owner
}

function readJournalJson(path: string) {
  const info = lstatSync(path)
  if (!info.isFile() || info.size > 16 * 1024)
    throw new Error('Unattributed artifact preparation owner')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let bytes: Buffer
  try {
    const buffer = Buffer.alloc(16 * 1024 + 1)
    let count = 0
    for (;;) {
      const read = readSync(fd, buffer, count, buffer.length - count, null)
      if (!read) break
      count += read
      if (count === buffer.length) throw new Error('Unattributed artifact preparation owner')
    }
    bytes = buffer.subarray(0, count)
  } finally {
    closeSync(fd)
  }
  return JSON.parse(bytes.toString('utf8'))
}

/** Capture before cleanup: a rolled-back publication may own a final blob but no version row. */
export function artifactPreparationBlobHashes(
  root: string,
  ids: { taskIds: readonly string[]; artifactIds?: readonly string[] }
): string[] {
  const journalRoot = join(root, 'artifacts', '.transactions'),
    hashes = new Set<string>()
  if (!existsSync(journalRoot)) return []
  for (const entry of readdirSync(journalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error('Unattributed artifact preparation entry')
    const dir = join(journalRoot, entry.name),
      owner = readArtifactPreparationOwner(dir)
    if (
      !owner ||
      (!ids.taskIds.includes(owner.taskId) && !ids.artifactIds?.includes(owner.artifactId ?? ''))
    )
      continue
    const path = join(dir, 'blob.json')
    if (!existsSync(path)) continue
    const blob = readJournalJson(path)
    if (
      blob?.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(blob.sha256) ||
      !Number.isSafeInteger(blob.size) ||
      blob.size < 0
    )
      throw new Error('Unattributed artifact publication blob inventory')
    hashes.add(blob.sha256)
  }
  return [...hashes]
}
