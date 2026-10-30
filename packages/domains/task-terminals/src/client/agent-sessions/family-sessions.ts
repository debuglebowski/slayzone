import type { TaskSessionRow } from './TaskSessionsSource'

/** A session row with the mode that ran it (the Claude chat and terminal share them). */
export interface FamilySessionRow extends TaskSessionRow {
  /** The mode whose ledger the row comes from — where a switch takes it from. */
  mode: string
}

/**
 * One list for a mode and its hand-off partner (Claude Code chat ↔ the Claude
 * Code terminal: one CLI, one session store), one row per conversation, in the
 * order the sessions started (newest first, like each mode's own list — a
 * switch never moves a card). A conversation both modes ran (handed over) shows
 * once: under the mode that ran it last, from its first start, with all its
 * activity. It is current only when it is `mode`'s current conversation.
 */
export function mergeFamilySessions(args: {
  mode: string
  own: readonly TaskSessionRow[]
  partner: string | null
  other: readonly TaskSessionRow[]
}): FamilySessionRow[] {
  const byId = new Map<string, FamilySessionRow>()
  const add = (rows: readonly TaskSessionRow[], rowMode: string, currentHere: boolean): void => {
    for (const row of rows) {
      const prev = byId.get(row.conversationId)
      const next: FamilySessionRow = {
        ...row,
        mode: rowMode,
        isCurrent: currentHere && row.isCurrent
      }
      if (!prev) {
        byId.set(row.conversationId, next)
        continue
      }
      const latest = row.lastActiveAt > prev.lastActiveAt ? next : prev
      byId.set(row.conversationId, {
        ...latest,
        startedAt: Math.min(prev.startedAt, row.startedAt),
        lastActiveAt: Math.max(prev.lastActiveAt, row.lastActiveAt),
        isCurrent: prev.isCurrent || next.isCurrent
      })
    }
  }
  add(args.own, args.mode, true)
  if (args.partner) add(args.other, args.partner, false)
  return [...byId.values()].sort(
    (a, b) => b.startedAt - a.startedAt || b.lastActiveAt - a.lastActiveAt
  )
}
