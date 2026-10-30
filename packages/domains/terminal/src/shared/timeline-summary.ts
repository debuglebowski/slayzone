/**
 * What the whole-history features need from rows that are not loaded (paged
 * history): per page of rows, a small summary (turn outline, rewind picker,
 * folds, files-changed count, attachment budget, latest question) and the text
 * search looks in. The hub stores both with each page; a client computes the
 * same for the rows it holds — one function, so both agree.
 */
import type { TimelineItem } from './chat-timeline'
import { fileChangesOf } from './turn-file-changes'

type UserText = Extract<TimelineItem, { kind: 'user-text' }>
type Branch = Extract<TimelineItem, { kind: 'conversation-branch' }>

export interface TimelinePageSummary {
  /** Every user message row (its whole item: outline, rewind picker, active ids, budget). */
  users: Array<{ row: number; item: UserText }>
  /** What ended a turn (the outline's status). */
  ends: Array<{ row: number; kind: 'result' | 'turn-error' | 'interrupted'; isError: boolean }>
  /** `conversation-branch` rows (folds; the rows they hide are by index). */
  branches: Array<{ row: number; item: Branch }>
  /**
   * Files tool rows changed, one entry per file (a Codex file change: several
   * with the same row) — the files-changed count; the panel loads their pages.
   */
  files: Array<{ row: number; path: string }>
  /** Rows where the attachment budget starts again (a compaction, a fresh start). */
  boundaries: number[]
  /** `AskUserQuestion` calls (the newest one stays open). */
  asks: Array<{ row: number; id: string }>
  /** Root rows (a height estimate for a page not loaded). */
  rootRows: number
}

/** The text chat search looks in for a row ('' = none). Shared with the hub. */
export function searchableText(item: TimelineItem): string {
  switch (item.kind) {
    case 'user-text':
    case 'text':
    case 'thinking':
    case 'stderr':
    case 'command-output':
    case 'turn-error':
    case 'notice':
      return item.text
    case 'result':
      return item.text ?? ''
    case 'agent-problem':
      return item.message
    case 'compaction':
      return item.error ?? ''
    case 'hook':
      return `${item.hookName} ${item.text}`
    case 'tool': {
      const inv = item.invocation
      let hay = `${inv.name} ${typeof inv.input === 'string' ? inv.input : JSON.stringify(inv.input)}`
      // A hook's block shown on the card (its row is folded into it).
      if (inv.blockedBy) hay += ` ${inv.blockedBy.hookName} ${inv.blockedBy.text}`
      return hay
    }
    default:
      return ''
  }
}

/** Separates rows in a page's search text, so no match spans two rows. */
const ROW_SEPARATOR = '\u0000'

/**
 * A page's search text: every row's {@link searchableText}, lowercased (a
 * case-sensitive search narrows to these pages, then checks the rows).
 */
export function pageSearchText(rows: readonly TimelineItem[]): string {
  return rows.map((r) => searchableText(r).toLowerCase()).join(ROW_SEPARATOR)
}

/** The summary of `rows`, the first at row `from`. */
export function summarizeRows(rows: readonly TimelineItem[], from: number): TimelinePageSummary {
  const out: TimelinePageSummary = {
    users: [],
    ends: [],
    branches: [],
    files: [],
    boundaries: [],
    asks: [],
    rootRows: 0
  }
  rows.forEach((item, k) => {
    const row = from + k
    if (item.parentToolUseId == null) out.rootRows++
    switch (item.kind) {
      case 'user-text':
        out.users.push({ row, item })
        break
      case 'result':
        out.ends.push({ row, kind: 'result', isError: item.isError })
        break
      case 'turn-error':
        out.ends.push({ row, kind: 'turn-error', isError: true })
        break
      case 'interrupted':
        out.ends.push({ row, kind: 'interrupted', isError: false })
        break
      case 'conversation-branch':
        out.branches.push({ row, item })
        break
      case 'compaction':
        if (item.outcome === 'compacted') out.boundaries.push(row)
        break
      case 'notice':
        if (item.code === 'resume-failed-fresh-start') out.boundaries.push(row)
        break
      case 'tool': {
        if (item.invocation.name === 'AskUserQuestion')
          out.asks.push({ row, id: item.invocation.id })
        // Every file of the call (a Codex file change names several).
        for (const change of fileChangesOf(item.invocation))
          out.files.push({ row, path: change.path })
        break
      }
    }
  })
  return out
}
