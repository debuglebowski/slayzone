/**
 * The server's gate for attached files (plan item 3.5), run where a message
 * enters: `chat.send` and the queue's push/update. The composer checks the same
 * things first; this is the check that counts.
 *
 *   - the tab's chat must take files (`attachments: 'blocks'`; Codex doesn't);
 *   - every file must be an artifact of the tab's OWN task — a message can
 *     never make the hub read another task's (or user's) files;
 *   - the conversation must stay within its attachment budget (sent since the
 *     last compaction + queued + this message);
 *   - each file is SEALED to its current content hash, so whenever the message
 *     is finally written (queued, retried, resent to a new process) the agent
 *     gets exactly the bytes that were attached.
 *
 * @module terminal/server/runtime/chat-attachment-guard
 */
import {
  chatCapabilitiesForMode,
  conversationAttachmentBytes,
  conversationBudgetError,
  attachmentEncodedBytes,
  userMessageAttachments,
  type AgentEvent,
  type BudgetEntry,
  type ChatAttachment,
  type UserContentBlock
} from '@slayzone/terminal-contracts'

export class ChatAttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatAttachmentError'
  }
}

/** What the gate reads (the local-DB implementation lives in `chat-data-ops.ts`). */
export interface AttachmentLookup {
  /** The tab's task and chat mode; null for an unknown tab. */
  tab(tabId: string): Promise<{ taskId: string; mode: string } | null>
  /** Owner task + current content hash per artifact id; ids that don't exist are absent. */
  artifacts(ids: string[]): Promise<Map<string, { taskId: string; contentHash: string | null }>>
  /** Files of the tab's queued (not yet sent) messages, except `exceptId`. */
  queued(tabId: string, exceptId?: string): Promise<ChatAttachment[]>
  /** `contentHash` is a version of that artifact (blobs are shared by hash, so a bare hash proves nothing). */
  hasVersion(artifactId: string, contentHash: string): Promise<boolean>
}

/** A tab's saved events as the budget counts them. */
export function budgetEntriesFromEvents(events: Iterable<AgentEvent>): BudgetEntry[] {
  const out: BudgetEntry[] = []
  for (const event of events) {
    if (event.kind === 'user-message') {
      out.push({
        type: 'message',
        ...(event.id ? { id: event.id } : {}),
        attachments: userMessageAttachments(event.content ?? [])
      })
    } else if (
      event.kind === 'compact-boundary' ||
      (event.kind === 'notice' && event.code === 'resume-failed-fresh-start')
    ) {
      out.push({ type: 'boundary' })
    }
  }
  return out
}

/**
 * The content to take for this tab: unchanged when it carries no files, else
 * checked and sealed. Throws `ChatAttachmentError` with a user-facing reason.
 */
export async function admitAttachments(args: {
  tabId: string
  content: UserContentBlock[]
  lookup: AttachmentLookup
  /** The tab's saved events (for the budget). */
  events: Iterable<AgentEvent>
  /** A queued message being edited: its old files don't count twice. */
  exceptQueuedId?: string
}): Promise<UserContentBlock[]> {
  const files = userMessageAttachments(args.content)
  if (files.length === 0) return args.content

  const tab = await args.lookup.tab(args.tabId)
  if (!tab) throw new ChatAttachmentError('This chat tab no longer exists.')
  if (chatCapabilitiesForMode(tab.mode).attachments !== 'blocks') {
    throw new ChatAttachmentError(
      "This chat can't take attached files. Send the message without them."
    )
  }

  const owners = await args.lookup.artifacts([...new Set(files.map((f) => f.artifactId))])
  for (const f of files) {
    const owner = owners.get(f.artifactId)
    if (!owner || owner.taskId !== tab.taskId) {
      throw new ChatAttachmentError(`${f.name} is not a file of this task. Attach it again.`)
    }
  }

  let used = conversationAttachmentBytes(budgetEntriesFromEvents(args.events))
  for (const q of await args.lookup.queued(args.tabId, args.exceptQueuedId)) {
    used += attachmentEncodedBytes(q)
  }
  const overBudget = conversationBudgetError(used, files)
  if (overBudget) throw new ChatAttachmentError(overBudget)

  const sealed: UserContentBlock[] = []
  for (const b of args.content) {
    if (b.type !== 'attachment') {
      sealed.push(b)
      continue
    }
    const { contentHash, ...rest } = b.attachment
    // A hash from the client counts only if it is a version of THIS artifact.
    if (contentHash && (await args.lookup.hasVersion(b.attachment.artifactId, contentHash))) {
      sealed.push(b)
      continue
    }
    const current = owners.get(b.attachment.artifactId)?.contentHash
    sealed.push({
      type: 'attachment',
      attachment: current ? { ...rest, contentHash: current } : rest
    })
  }
  return sealed
}
