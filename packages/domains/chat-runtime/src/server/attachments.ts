import { createHash } from 'node:crypto'
import { lstatSync, unlinkSync } from 'node:fs'
import {
  attachmentSizeError,
  sniffAttachment,
  type ChatAttachment
} from '@slayzone/terminal-contracts'
import type { ChatAttachmentReader } from '@slayzone/terminal/runtime'
import type { ChatStorage } from './storage'
import { readFileRangePage } from './blob-store'
import type { ByteRangePage } from '@slayzone/platform/bounded-reads'
import type { createLocalChatData } from './local-data'

const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
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
  // The store's content-addressed blob dir (shared with event blobs).
  const { dir, readBlob, writeBlob, collectStaging, blobPath } = store.blobs
  // Repair pre-fix imported references before retention or GC can remove the
  // original conversation's last pin. New writes pin atomically in storage.
  store.repairAttachmentPins()
  collectStaging()
  /** The stored blob a reference names (any conversation on this computer). */
  function storedHashOf(ref: Pick<ChatAttachment, 'artifactId' | 'contentHash'>): string {
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
    return found.contentHash
  }
  const reader: ChatAttachmentReader = {
    read: async (ref) => readBlob(storedHashOf(ref))
  }
  /**
   * A hub's read of `ref` for conversation `route` (a session move): the
   * conversation must be live at that epoch and hold the attachment.
   */
  function checkHeld(route: { id: string; epoch: number }, ref: ChatAttachment): void {
    const owner = store.conversation(route.id)
    if (!owner || owner.identity.epoch !== route.epoch || owner.state === 'deleted')
      throw new Error('Attachment ownership mismatch')
    const held = store
      .records(route.id, 'attachment')
      .some(
        (row) =>
          row.kind === 'attachment' &&
          (row.value as { artifactId: string; contentHash: string }).artifactId ===
            ref.artifactId &&
          (!ref.contentHash ||
            (row.value as { contentHash: string }).contentHash === ref.contentHash)
      )
    if (!held) throw new Error('Attachment does not belong to this conversation')
  }
  return {
    dir,
    reader,
    readBlob,
    /** `ref`'s bytes for conversation `route` (`attachment.read`). */
    readFor(route: { id: string; epoch: number }, ref: ChatAttachment): Promise<Uint8Array> {
      checkHeld(route, ref)
      return reader.read(ref)
    },
    /** One range of `ref` for conversation `route` (the reader verifies the hash = `etag`). */
    range(
      route: { id: string; epoch: number },
      ref: ChatAttachment,
      offset: number,
      length: number
    ): ByteRangePage {
      checkHeld(route, ref)
      const hash = storedHashOf(ref)
      return readFileRangePage(blobPath(hash), offset, length, hash)
    },
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
        // Alive while pinned: by an attachment (user upload) or an event blob
        // (out-of-line payload of a saved event), in a conversation not deleted.
        const referenced = new Set([
          ...store.findRecords('attachment').map((r) => (r.value as ChatAttachment).contentHash),
          ...store.eventBlobHashes()
        ])
        let removed = 0
        for (const name of store.blobs.list())
          if (!referenced.has(name)) {
            const path = store.blobs.blobPath(name)
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
