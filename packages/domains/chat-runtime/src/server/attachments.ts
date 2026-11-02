import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  readdirSync
} from 'node:fs'
import { join } from 'node:path'
import {
  attachmentSizeError,
  sniffAttachment,
  type ChatAttachment
} from '@slayzone/terminal-contracts'
import type { ChatAttachmentReader } from '@slayzone/terminal/runtime'
import type { ChatStorage } from './storage'
import type { createLocalChatData } from './local-data'

const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const activeUploads = new Set<string>()
/** An `attachment` record value: the ref plus its owning task (storage-only scope). */
type StoredAttachment = ChatAttachment & { taskId?: string }
/** Storage record → wire ref. Explicit pick, so no storage-only field leaks onto the wire. */
function attachmentRef(stored: StoredAttachment): ChatAttachment {
  const { artifactId, contentHash, name, kind, mediaType, size } = stored
  return { artifactId, ...(contentHash ? { contentHash } : {}), name, kind, mediaType, size }
}
export function createLocalAttachments(
  store: ChatStorage,
  local: ReturnType<typeof createLocalChatData>
) {
  const dir = join(store.dir, 'blobs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Repair pre-fix imported references before retention or GC can remove the
  // original conversation's last pin. New writes pin atomically in storage.
  store.repairAttachmentPins()
  function collectStaging() {
    for (const name of readdirSync(dir)) {
      if (!/^\.upload-(?:\d+-)?[a-f0-9-]{36}$/.test(name)) continue
      const path = join(dir, name)
      if (activeUploads.has(path)) continue
      const pid = /^\.upload-(\d+)-/.exec(name)?.[1]
      if (pid && Number(pid) !== process.pid) {
        try {
          process.kill(Number(pid), 0)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
        }
      }
      if (lstatSync(path).isFile()) unlinkSync(path)
    }
  }
  collectStaging()
  function blobPath(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid attachment hash')
    return join(dir, hash)
  }
  function readBlob(hash: string): Uint8Array {
    const path = blobPath(hash)
    if (!lstatSync(path).isFile()) throw new Error('Attachment is not a regular file')
    const bytes = readFileSync(path)
    if (hashOf(bytes) !== hash) throw new Error('Attachment hash integrity failure')
    return bytes
  }
  function writeBlob(hash: string, bytes: Uint8Array) {
    const path = blobPath(hash)
    if (existsSync(path)) {
      try {
        readBlob(hash)
        return
      } catch {
        /* Verified caller bytes repair a corrupt local copy. */
      }
    }
    const temp = join(dir, `.upload-${process.pid}-${randomUUID()}`)
    activeUploads.add(temp)
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try {
        writeFileSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, path)
      if (process.platform !== 'win32') {
        const parent = openSync(dir, 'r')
        try {
          fsyncSync(parent)
        } finally {
          closeSync(parent)
        }
      }
    } finally {
      activeUploads.delete(temp)
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
  const reader: ChatAttachmentReader = {
    read: async (ref) => {
      const records = store.findRecords('attachment').map((r) => r.value as ChatAttachment)
      const matching = records.filter(
        (a) =>
          a.artifactId === ref.artifactId && (!ref.contentHash || a.contentHash === ref.contentHash)
      )
      if (!ref.contentHash && new Set(matching.map((a) => a.contentHash)).size > 1)
        throw new Error('Attachment version is ambiguous; select an explicit saved version')
      const found = matching[0]
      if (!found?.contentHash)
        throw new Error('Attachment artifact/version does not belong to this hub')
      return readBlob(found.contentHash)
    }
  }
  return {
    dir,
    reader,
    readBlob,
    putPrepared(id: string, epoch: number, ref: ChatAttachment, bytes: Uint8Array): void {
      store.transaction(() => {
        const owner = store.conversation(id)
        if (!owner || owner.identity.epoch !== epoch || owner.state !== 'prepared')
          throw new Error('Migration attachment ownership mismatch')
        const record = store.getRecord<ChatAttachment>(
          id,
          'attachment',
          `${ref.artifactId}:${ref.contentHash}`
        )
        if (
          !record ||
          !ref.contentHash ||
          record.contentHash !== ref.contentHash ||
          hashOf(bytes) !== ref.contentHash
        )
          throw new Error('Migration attachment hash mismatch')
        if (
          record.size !== bytes.length ||
          ref.size !== record.size ||
          ref.name !== record.name ||
          ref.kind !== record.kind ||
          ref.mediaType !== record.mediaType
        )
          throw new Error('Migration attachment metadata does not match its saved bytes')
        const sniff = sniffAttachment(bytes, record.name)
        if (
          sniff.kind === 'unsupported' ||
          sniff.kind !== record.kind ||
          sniff.mediaType !== record.mediaType
        )
          throw new Error('Migration attachment content does not match its saved type')
        const limit = attachmentSizeError(ref.kind, ref.name, bytes.length)
        if (limit) throw new Error(limit)
        writeBlob(ref.contentHash, bytes)
      })
    },
    /** Wire refs (the hub sends each back as a strict `attachment.put` ref), not stored records. */
    missing(id: string): ChatAttachment[] {
      return store
        .records(id, 'attachment')
        .map((r) => attachmentRef(r.value as StoredAttachment))
        .filter((ref) => {
          try {
            return !ref.contentHash || readBlob(ref.contentHash).length !== ref.size
          } catch {
            return true
          }
        })
    },
    put(tabId: string, ref: ChatAttachment, bytes: Uint8Array): ChatAttachment {
      return store.transaction(() => {
        const owner = local.owner(tabId),
          hash = hashOf(bytes)
        if (ref.contentHash && ref.contentHash !== hash) throw new Error('Attachment hash mismatch')
        const sniff = sniffAttachment(bytes, ref.name)
        if (
          sniff.kind === 'unsupported' ||
          sniff.kind !== ref.kind ||
          sniff.mediaType !== ref.mediaType
        )
          throw new Error('Attachment content does not match its type')
        const limit = attachmentSizeError(ref.kind, ref.name, bytes.length)
        if (limit) throw new Error(limit)
        writeBlob(hash, bytes)
        const sealed = { ...ref, size: bytes.length, contentHash: hash }
        store.putRecord(owner.id, owner.epoch, {
          kind: 'attachment',
          id: `${ref.artifactId}:${hash}`,
          value: { ...sealed, taskId: owner.taskId },
          at: Date.now()
        })
        return sealed
      })
    },
    collectGarbage() {
      return store.transaction(() => {
        collectStaging()
        if (store.hasBlobLeases()) return { removed: 0 }
        const referenced = new Set(
          store.findRecords('attachment').map((r) => (r.value as ChatAttachment).contentHash)
        )
        let removed = 0
        for (const name of readdirSync(dir))
          if (/^[a-f0-9]{64}$/.test(name) && !referenced.has(name)) {
            const path = blobPath(name)
            if (lstatSync(path).isFile()) {
              unlinkSync(path)
              removed++
            }
          }
        return { removed }
      })
    }
  }
}
