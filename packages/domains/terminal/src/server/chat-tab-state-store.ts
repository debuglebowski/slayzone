import type { SlayzoneDb } from '@slayzone/platform'
import type {
  ChatAttachment,
  ChatDraft,
  ChatScrollAnchor,
  ChatTabState
} from '@slayzone/terminal-contracts'

/**
 * A chat tab's draft and scroll anchor (`chat_tab_state`, migration v177). One
 * row per tab, gone with it. A save for a tab that no longer exists (closed
 * meanwhile) is dropped, never thrown.
 */

function isForeignKeyError(err: unknown): boolean {
  return err instanceof Error && /FOREIGN KEY/i.test(err.message)
}

/** Upsert the draft; resolves the new revision, or null when the tab is gone. */
export async function saveChatDraft(
  db: SlayzoneDb,
  tabId: string,
  draft: ChatDraft,
  now: number = Date.now()
): Promise<{ rev: number } | null> {
  try {
    await db
      .prepare(
        `INSERT INTO chat_tab_state (tab_id, draft_text, draft_attachments, rev, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (tab_id) DO UPDATE SET
           draft_text = excluded.draft_text,
           draft_attachments = excluded.draft_attachments,
           rev = chat_tab_state.rev + 1,
           updated_at = excluded.updated_at`
      )
      .run(
        tabId,
        draft.text,
        draft.attachments.length > 0 ? JSON.stringify(draft.attachments) : null,
        now
      )
  } catch (err) {
    if (isForeignKeyError(err)) return null
    throw err
  }
  const row = (await db.prepare(`SELECT rev FROM chat_tab_state WHERE tab_id = ?`).get(tabId)) as
    | { rev: number }
    | undefined
  return row ? { rev: row.rev } : null
}

/** Upsert the scroll anchor (a tab that is gone: dropped). */
export async function saveChatScroll(
  db: SlayzoneDb,
  tabId: string,
  anchor: ChatScrollAnchor,
  now: number = Date.now()
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO chat_tab_state (tab_id, scroll_anchor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (tab_id) DO UPDATE SET
           scroll_anchor = excluded.scroll_anchor,
           updated_at = excluded.updated_at`
      )
      .run(tabId, JSON.stringify(anchor), now)
  } catch (err) {
    if (!isForeignKeyError(err)) throw err
  }
}

function parseAttachments(raw: string | null): ChatAttachment[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as ChatAttachment[]) : []
  } catch {
    return []
  }
}

function parseAnchor(raw: string | null): ChatScrollAnchor | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<{
      atBottom: unknown
      key: unknown
      offsetPx: unknown
    }> | null
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    if (v.atBottom === true) return { atBottom: true }
    if (v.atBottom === false && typeof v.key === 'string' && typeof v.offsetPx === 'number') {
      return { atBottom: false, key: v.key, offsetPx: v.offsetPx }
    }
    return null
  } catch {
    return null
  }
}

export async function getChatTabState(db: SlayzoneDb, tabId: string): Promise<ChatTabState | null> {
  const row = (await db
    .prepare(
      `SELECT draft_text, draft_attachments, scroll_anchor, rev FROM chat_tab_state WHERE tab_id = ?`
    )
    .get(tabId)) as
    | {
        draft_text: string
        draft_attachments: string | null
        scroll_anchor: string | null
        rev: number
      }
    | undefined
  if (!row) return null
  return {
    draft: {
      text: row.draft_text,
      attachments: parseAttachments(row.draft_attachments),
      rev: row.rev
    },
    scroll: parseAnchor(row.scroll_anchor)
  }
}
