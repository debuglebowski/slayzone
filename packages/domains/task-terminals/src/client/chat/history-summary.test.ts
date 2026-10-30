/**
 * The whole-history summary (paged history, chat F): with any pages not loaded
 * (the hub's page summaries standing in for them), it equals the summary of
 * the full timeline — so the outline, rewind picker, files count and
 * attachment budget never depend on what happens to be loaded.
 */
import { describe, expect, test } from 'vitest'
import {
  selectConversationAttachmentBytes,
  summarizeRows,
  type ChatPaging,
  type TimelineItem,
  type TimelineRows
} from '@slayzone/terminal/client'
import { initialState, reducer } from '@slayzone/terminal/reducer'
import { buildLongSession } from '@slayzone/test-utils/chat-long-session'
import {
  activeUserRows,
  attachmentBytesOf,
  historySummary,
  sessionFileCount
} from './history-summary'
import { countSessionFiles } from './files-changed/session-file-changes'

const PAGE_ROWS = 64

describe.each(['claude', 'codex'] as const)('%s session', (provider) => {
  const state = reducer(initialState({ agentStartedTurns: provider === 'claude' }), {
    type: 'events',
    events: buildLongSession({ events: 3_000, seed: 4, provider })
  })
  const full = state.timeline as TimelineItem[]
  const sealed = Math.floor(full.length / PAGE_ROWS) - 1
  const paging: ChatPaging = {
    pageRows: PAGE_ROWS,
    sealed,
    summaries: Array.from({ length: sealed }, (_, p) =>
      summarizeRows(full.slice(p * PAGE_ROWS, (p + 1) * PAGE_ROWS), p * PAGE_ROWS)
    )
  }
  /** The timeline with `pages` not loaded. */
  const without = (pages: number[]): TimelineRows => {
    const rows: TimelineRows = [...full]
    for (const p of pages) rows.fill(undefined, p * PAGE_ROWS, (p + 1) * PAGE_ROWS)
    return rows
  }
  const whole = historySummary(full, null)

  test('pages not loaded: the same summary as the full timeline', () => {
    expect(whole.users.length).toBeGreaterThan(10)
    // The files it lists are the ones the files-changed panel finds in the
    // full timeline (every file-changing tool the panel knows, any provider).
    expect(sessionFileCount(whole, new Set())).toBe(countSessionFiles(full))
    for (const pages of [
      [0],
      [1, 2, 3],
      Array.from({ length: sealed }, (_, i) => i),
      [sealed - 1]
    ]) {
      expect(historySummary(without(pages), paging)).toEqual(whole)
    }
  })

  test('what the features read from it: the same, loaded or not', () => {
    const paged = historySummary(
      without(Array.from({ length: sealed }, (_, i) => i).filter((p) => p % 2 === 0)),
      paging
    )
    const folded = new Set([whole.users[2].row])
    expect(activeUserRows(paged, folded)).toEqual(activeUserRows(whole, folded))
    expect(activeUserRows(paged, folded).some((u) => u.row === whole.users[2].row)).toBe(false)
    expect(sessionFileCount(paged, new Set())).toBe(sessionFileCount(whole, new Set()))
    expect(attachmentBytesOf(paged)).toBe(selectConversationAttachmentBytes(state))
  })
})
