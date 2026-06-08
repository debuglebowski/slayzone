import type { SlayzoneDb } from '@slayzone/platform'
import type { ProviderConfig } from '@slayzone/task/shared'
import { safeJsonParse } from './shared.js'

/**
 * Task-domain support for conversation self-heal (see plans/conv-id-robustness-v2.md
 * and rest-api/agent-hook + pty-manager wiring). Kept in the task domain so all
 * `provider_config` / legacy-column knowledge stays owned here.
 */

/** TerminalMode → its legacy `<col>_conversation_id` column. */
const MODE_LEGACY_COL: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  'cursor-agent': 'cursor',
  gemini: 'gemini',
  opencode: 'opencode'
}

const LEGACY_COLS = ['claude', 'codex', 'cursor', 'gemini', 'opencode'] as const

/**
 * Every conversation id referenced by ANY task — current `conversationId`,
 * `conversationHistory`, and the legacy `*_conversation_id` columns — across ALL
 * rows (active, archived, AND soft-deleted: those rows still hold their ids, which
 * is exactly why a soft-deleted task's transcript must NOT be treated as a free
 * orphan). The orphan self-heal excludes any candidate in this set so it can never
 * attach a transcript that belongs to another task.
 */
export async function collectReferencedConversationIds(db: SlayzoneDb): Promise<Set<string>> {
  const cols = LEGACY_COLS.map((c) => `${c}_conversation_id`).join(', ')
  const rows = await db.all<Record<string, unknown>>(
    `SELECT provider_config, ${cols} FROM tasks`
  )
  const ids = new Set<string>()
  for (const row of rows) {
    for (const c of LEGACY_COLS) {
      const v = row[`${c}_conversation_id`]
      if (typeof v === 'string' && v) ids.add(v)
    }
    const cfg = safeJsonParse(row.provider_config) as ProviderConfig | undefined
    if (cfg) {
      for (const entry of Object.values(cfg)) {
        if (entry?.conversationId) ids.add(entry.conversationId)
        for (const h of entry?.conversationHistory ?? []) ids.add(h)
      }
    }
  }
  return ids
}

/**
 * Compare-and-swap repoint of a task's stored conversation id. Atomic at the
 * SQLite level: a single conditional UPDATE that only fires while the stored id
 * still equals `expected`, so it can never clobber a concurrent write (e.g. a
 * racing SessionStart persist or a worktree-change reset). Dual-writes the legacy
 * column. Does NOT touch `updated_at` (avoids spurious external-sync pushes for a
 * machine-written id; the caller refreshes the renderer directly). Returns whether
 * the row was updated. `conversationHistory` is intentionally not appended here —
 * the subsequent `--resume` fires SessionStart, whose persist path backfills it.
 */
export async function casRepointConversationId(
  db: SlayzoneDb,
  args: { id: string; mode: string; expected: string; next: string }
): Promise<boolean> {
  const { id, mode, expected, next } = args
  const path = `$."${mode}".conversationId`
  const legacyCol = MODE_LEGACY_COL[mode]
  const setLegacy = legacyCol ? `, ${legacyCol}_conversation_id = ?` : ''
  const params: unknown[] = [path, next]
  if (legacyCol) params.push(next)
  params.push(id, path, expected)
  const res = await db.run(
    `UPDATE tasks
     SET provider_config = json_set(provider_config, ?, ?)${setLegacy}
     WHERE id = ? AND json_extract(provider_config, ?) = ?`,
    params
  )
  return res.changes > 0
}
