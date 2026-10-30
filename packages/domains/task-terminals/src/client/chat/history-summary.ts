import { conversationAttachmentBytes, type BudgetEntry } from '@slayzone/terminal-contracts'
import {
  summarizeRows,
  type ChatPaging,
  type TimelineItem,
  type TimelinePageSummary,
  type TimelineRows
} from '@slayzone/terminal/client'

/** An empty summary (merged into). */
function emptySummary(): TimelinePageSummary {
  return { users: [], ends: [], branches: [], files: [], boundaries: [], asks: [], rootRows: 0 }
}

function addTo(out: TimelinePageSummary, s: TimelinePageSummary): void {
  out.users.push(...s.users)
  out.ends.push(...s.ends)
  out.branches.push(...s.branches)
  out.files.push(...s.files)
  out.boundaries.push(...s.boundaries)
  out.asks.push(...s.asks)
  out.rootRows += s.rootRows
}

/**
 * What the whole-history features need, for the WHOLE history: the rows here
 * summarized, and for a page not loaded (paged history) the summary the hub
 * sent for it — rows in order. Pages load and unload whole.
 */
export function historySummary(
  timeline: Readonly<TimelineRows>,
  paging: ChatPaging | null | undefined
): TimelinePageSummary {
  const out = emptySummary()
  let i = 0
  while (i < timeline.length) {
    if (timeline[i] === undefined) {
      if (!paging) {
        i++
        continue
      }
      const page = Math.floor(i / paging.pageRows)
      const summary = paging.summaries[page]
      if (summary) addTo(out, summary)
      i = (page + 1) * paging.pageRows
      continue
    }
    let j = i
    while (j < timeline.length && timeline[j] !== undefined) j++
    addTo(out, summarizeRows(timeline.slice(i, j) as TimelineItem[], i))
    i = j
  }
  return out
}

/** The user message rows the conversation still holds (edit / rewind / fork act on them). */
export function activeUserRows(
  summary: TimelinePageSummary,
  conversationFolded: ReadonlySet<number>
): TimelinePageSummary['users'] {
  return summary.users.filter(
    (u) =>
      u.item.id &&
      u.item.parentToolUseId == null &&
      u.item.delivery !== 'failed' &&
      !conversationFolded.has(u.row)
  )
}

/** Files the conversation changed (the files-changed button's count), over the whole history. */
export function sessionFileCount(
  summary: TimelinePageSummary,
  conversationFolded: ReadonlySet<number>
): number {
  const paths = new Set<string>()
  for (const f of summary.files) if (!conversationFolded.has(f.row)) paths.add(f.path)
  return paths.size
}

/**
 * Encoded bytes of the files this conversation carries since its last
 * compaction (or fresh start), over the whole history — as
 * `selectConversationAttachmentBytes` reads them from the rows.
 */
export function attachmentBytesOf(summary: TimelinePageSummary): number {
  const entries: Array<{ row: number; entry: BudgetEntry }> = []
  for (const u of summary.users) {
    if (!u.item.attachments) continue
    entries.push({
      row: u.row,
      entry: {
        type: 'message',
        ...(u.item.id ? { id: u.item.id } : {}),
        attachments: u.item.attachments
      }
    })
  }
  for (const row of summary.boundaries) entries.push({ row, entry: { type: 'boundary' } })
  entries.sort((a, b) => a.row - b.row)
  return conversationAttachmentBytes(entries.map((e) => e.entry))
}
