import { apiPost } from '../../api'
import { resolveId } from './_shared'

export interface ResetConversationOpts {
  mode?: string
  tab?: string
  allTabs?: boolean
}

/**
 * Reset a task's agent sessions: the next spawn in scope starts fresh. Sessions
 * are scoped per terminal tab — default the task's main tab, `--tab` one tab (id,
 * unique id prefix, or label), `--all-tabs` every tab. `--mode` limits it to one
 * agent; default every agent with a session in scope.
 *
 * A reset intent the hub delivers to the task's computer; earlier sessions stay in
 * the history (and can be switched back to).
 *
 * POST /api/tasks/:id/reset-conversation owns id-prefix + tab resolution and the
 * write, and returns the resolved task id, the reset tab and the reset modes.
 */
export async function resetConversationAction(
  idPrefix: string | undefined,
  opts: ResetConversationOpts
): Promise<void> {
  if (opts.tab !== undefined && opts.allTabs) {
    console.error('Pass either --tab or --all-tabs, not both.')
    process.exit(1)
  }
  idPrefix = await resolveId(idPrefix)
  const { data } = await apiPost<{
    ok: true
    data: { id: string; tab: string; reset: string[] }
  }>(`/api/tasks/${encodeURIComponent(idPrefix)}/reset-conversation`, {
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.tab !== undefined ? { tab: opts.tab } : {}),
    ...(opts.allTabs ? { allTabs: true } : {})
  })

  const shortId = data.id.slice(0, 8)
  const tab =
    data.tab === 'all'
      ? 'all tabs'
      : data.tab === data.id
        ? 'main tab'
        : `tab ${data.tab.slice(0, 8)}`
  if (data.reset.length === 0) {
    console.log(`No sessions for ${shortId} (${tab}) — nothing to reset.`)
    return
  }
  for (const mode of data.reset) {
    // `*`: the task's computer is offline — every agent resets once it connects.
    const which = mode.startsWith('*')
      ? 'every agent (applied when its computer connects)'
      : `mode=${mode}`
    console.log(`Reset: ${shortId}  ${tab}  ${which}  (next spawn starts fresh)`)
  }
}
