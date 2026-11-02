import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
export function createLocalAttachments(
  store: ChatStorage,
  local: ReturnType<typeof createLocalChatData>
) {
  const dir = join(store.dir, 'blobs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
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
  const reader: ChatAttachmentReader = {
    read: async (ref) => {
      const records = store.findRecords('attachment').map((r) => r.value as ChatAttachment)
      const found = records.find(
        (a) =>
          a.artifactId === ref.artifactId && (!ref.contentHash || a.contentHash === ref.contentHash)
      )
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
      const limit = attachmentSizeError(ref.kind, ref.name, bytes.length)
      if (limit) throw new Error(limit)
      const path = blobPath(ref.contentHash),
        temp = join(dir, `.upload-${randomUUID()}`)
      writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' })
      renameSync(temp, path)
    },
    missing(id: string): ChatAttachment[] {
      return store
        .records(id)
        .filter((r) => r.kind === 'attachment')
        .map((r) => r.value as ChatAttachment)
        .filter((ref) => {
          try {
            return !ref.contentHash || readBlob(ref.contentHash).length !== ref.size
          } catch {
            return true
          }
        })
    },
    put(tabId: string, ref: ChatAttachment, bytes: Uint8Array): ChatAttachment {
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
      const path = blobPath(hash)
      if (!existsSync(path)) {
        const temp = join(dir, `.upload-${randomUUID()}`)
        writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' })
        renameSync(temp, path)
      } else readBlob(hash)
      const sealed = { ...ref, size: bytes.length, contentHash: hash }
      store.putRecord(owner.id, owner.epoch, {
        kind: 'attachment',
        id: `${ref.artifactId}:${hash}`,
        value: { ...sealed, taskId: owner.taskId },
        at: Date.now()
      })
      return sealed
    }
  }
}
