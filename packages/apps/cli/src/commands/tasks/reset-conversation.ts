import { apiPost } from '../../api'
import { resolveId } from './_shared'

export interface ResetConversationOpts {
  mode?: string
}

/**
 * Append a `manual-reset` sentinel row to `task_conversations` for the given
 * task (and optionally one specific mode). The next read of
 * `getCurrentConversationId` will return NULL because the cutoff hides every
 * earlier row, including the broken `legacy-migration` binding — slay's next
 * spawn for this task starts fresh.
 *
 * The bug class (eager-persist clobber) is closed structurally for new writes
 * after migration v145; this CLI exists to recover from the small set of
 * historic bad bindings the backfill carried forward.
 *
 * POST /api/tasks/:id/reset-conversation owns id-prefix resolution, the
 * append-only sentinel + session_resets triple-write, and returns the resolved
 * task id plus the list of reset modes (empty when nothing to reset).
 */
export async function resetConversationAction(
  idPrefix: string | undefined,
  opts: ResetConversationOpts
): Promise<void> {
  idPrefix = await resolveId(idPrefix)
  const { data } = await apiPost<{ ok: true; data: { id: string; reset: string[] } }>(
    `/api/tasks/${encodeURIComponent(idPrefix)}/reset-conversation`,
    opts.mode ? { mode: opts.mode } : {}
  )

  const shortId = data.id.slice(0, 8)
  if (data.reset.length === 0) {
    console.log(`No conversation rows for ${shortId} — nothing to reset.`)
    return
  }
  for (const mode of data.reset) {
    console.log(`Reset: ${shortId}  mode=${mode}  (next spawn starts fresh)`)
  }
}
