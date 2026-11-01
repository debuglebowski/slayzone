import type { ChatAttachment } from '@slayzone/terminal-contracts'

/** Reads an attached file's bytes. Supplied by the composition root (it owns the artifact store). */
export interface ChatAttachmentReader {
  /** The bytes with that content hash, else the artifact's current version. Rejects when gone. */
  read(ref: { artifactId: string; contentHash?: string }): Promise<Uint8Array>
}

let registeredReader: ChatAttachmentReader | undefined

/** Called once by the composition root, before any chat agent starts. */
export function setChatAttachmentReader(reader: ChatAttachmentReader | undefined): void {
  registeredReader = reader
}

export function getChatAttachmentReader(): ChatAttachmentReader | undefined {
  return registeredReader
}

export async function readAttachment(
  a: ChatAttachment,
  reader: ChatAttachmentReader
): Promise<Uint8Array> {
  try {
    return await reader.read(
      a.contentHash
        ? { artifactId: a.artifactId, contentHash: a.contentHash }
        : { artifactId: a.artifactId }
    )
  } catch {
    throw new Error(
      `${a.name} is no longer available (it was deleted or moved). Remove it and attach it again.`
    )
  }
}
