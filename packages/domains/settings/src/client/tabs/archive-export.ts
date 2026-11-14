/**
 * Export of an archived (restored backup) conversation: its history, records,
 * attachments and files in one JSON file (`slayzone-chat-archive` v1).
 *
 * Events hold images as the history saved them. A v13+ backup stores them
 * out-of-line (`chat-blobs`): each distinct one is read once, in chunks, verified
 * against its sha256, and put back inline — so the file is the same as a pre-v13
 * backup's export of the same history.
 *
 * @module settings/client/tabs/archive-export
 */
import {
  bytesToBase64,
  chatBlobRefs,
  readChatBlob,
  resolveChatBlobs,
  userMessageAttachments,
  type AgentEvent,
  type ArchivedArtifactOriginal,
  type ArchivedArtifactVersion,
  type ChatAttachment,
  type ChatBlobChunk,
  type QueuedChatMessage
} from '@slayzone/terminal-contracts'

export interface ArchiveTarget {
  computerId: string
  archiveId: string
  conversationId: string
}
type Query<I, O> = { query(input: I): Promise<O> }
type ArchivedEvent = { seq: number; at: number; event: AgentEvent }
type ArchivedRecord = { cursor: number; kind: string; id: string; value: unknown }

/** The hub's `chat.archives.*` procedures the export reads. */
export interface ArchiveExportApi {
  chat: {
    archives: {
      read: Query<
        ArchiveTarget & { afterSeq: number },
        { events: ArchivedEvent[]; hasMore: boolean; nextSeq: number }
      >
      records: Query<
        ArchiveTarget & { afterCursor: number },
        { records: ArchivedRecord[]; hasMore: boolean; nextCursor: number }
      >
      attachment: Query<ArchiveTarget & { ref: ChatAttachment }, { data: string }>
      file: Query<
        ArchiveTarget & { artifactId: string; contentHash: string },
        { name: string; data: string }
      >
      blob: Query<ArchiveTarget & { sha256: string; offset: number }, ChatBlobChunk>
    }
  }
}

/** Everything the export file holds (see the module doc). */
export async function collectArchivedConversation(api: ArchiveExportApi, target: ArchiveTarget) {
  const stored: ArchivedEvent[] = [],
    allRecords: ArchivedRecord[] = []
  let afterSeq = -1,
    afterCursor = 0
  while (true) {
    const page = await api.chat.archives.read.query({ ...target, afterSeq })
    stored.push(...page.events)
    if (!page.hasMore) break
    afterSeq = page.nextSeq
  }
  while (true) {
    const page = await api.chat.archives.records.query({ ...target, afterCursor })
    allRecords.push(...page.records)
    if (!page.hasMore) break
    afterCursor = page.nextCursor
  }
  // Images stored out-of-line: each distinct one read once, then put back inline.
  const inline = new Map<string, string>()
  const read = (sha256: string, offset: number) =>
    api.chat.archives.blob.query({ ...target, sha256, offset })
  for (const { event } of stored)
    for (const ref of chatBlobRefs(event))
      if (!inline.has(ref.sha256))
        inline.set(ref.sha256, bytesToBase64(await readChatBlob(read, ref)))
  const allEvents = stored.map((e) => ({
    ...e,
    event: resolveChatBlobs(e.event, (ref) => inline.get(ref.sha256)!)
  }))
  const refs = new Map<string, ChatAttachment>()
  for (const { event } of allEvents)
    if (event.kind === 'user-message')
      for (const ref of userMessageAttachments(event.content ?? []))
        refs.set(`${ref.artifactId}:${ref.contentHash ?? ''}`, ref)
  for (const record of allRecords)
    if (record.kind === 'draft') {
      const draft = record.value as { draft?: { attachments?: ChatAttachment[] } }
      for (const ref of draft.draft?.attachments ?? [])
        refs.set(`${ref.artifactId}:${ref.contentHash ?? ''}`, ref)
    } else if (record.kind === 'queue') {
      for (const ref of userMessageAttachments((record.value as QueuedChatMessage).content ?? []))
        refs.set(`${ref.artifactId}:${ref.contentHash ?? ''}`, ref)
    }
  const attachments: Array<{ ref: ChatAttachment; data: string }> = []
  for (const ref of refs.values())
    attachments.push({ ref, ...(await api.chat.archives.attachment.query({ ...target, ref })) })
  const files: Array<{
    version: ArchivedArtifactVersion | ArchivedArtifactOriginal
    name: string
    data: string
  }> = []
  for (const record of allRecords) {
    if (record.kind !== 'artifact-version' && record.kind !== 'artifact-original') continue
    const version = record.value as ArchivedArtifactVersion | ArchivedArtifactOriginal
    files.push({
      version,
      ...(await api.chat.archives.file.query({
        ...target,
        artifactId: version.artifactId,
        contentHash: version.contentHash
      }))
    })
  }
  return {
    format: 'slayzone-chat-archive' as const,
    version: 1 as const,
    readOnly: true as const,
    providerResumable: false as const,
    ...target,
    events: allEvents,
    records: allRecords,
    attachments,
    files
  }
}
