import type { Express } from 'express'
import { resetConversation } from '@slayzone/task/server'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * POST /api/tasks/:id/reset-conversation — reset a task's agent sessions so the
 * next spawn starts fresh. Mirrors `slay tasks reset-conversation` (cli/src/
 * commands/tasks/reset-conversation.ts).
 *
 * Body `{ mode?: string, tab?: string, allTabs?: boolean }`. Sessions are scoped
 * per terminal tab (v201):
 *   - no `tab` / `allTabs` → the task's MAIN tab (its id is the task id);
 *   - `tab` → one tab, by id, unique id prefix, or unique label;
 *   - `allTabs: true` → the whole task (every tab).
 * Without a `mode`, every mode is reset in that scope.
 *
 * The write is the task domain's one reset op (`resetConversation`): a reset intent
 * the hub keeps and delivers to the task's computers, where the session ledger
 * lives (robustness plan §9) — an offline computer gets it when it connects.
 * Responds with the resolved task id, the reset tab (`'all'` for every tab) and the
 * reset modes: the modes the computer holds sessions of (empty: nothing to reset),
 * or `['*']` (every mode) when that computer is offline.
 */
export function registerTaskResetConversationRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks/:id/reset-conversation', async (req, res) => {
    const body = (req.body ?? {}) as { mode?: unknown; tab?: unknown; allTabs?: unknown }
    if (body.mode !== undefined && typeof body.mode !== 'string') {
      res.status(400).json({ ok: false, error: 'mode must be a string' })
      return
    }
    if (body.tab !== undefined && typeof body.tab !== 'string') {
      res.status(400).json({ ok: false, error: 'tab must be a string' })
      return
    }
    if (body.allTabs !== undefined && typeof body.allTabs !== 'boolean') {
      res.status(400).json({ ok: false, error: 'allTabs must be a boolean' })
      return
    }
    if (body.tab !== undefined && body.allTabs) {
      res.status(400).json({ ok: false, error: 'Pass either tab or allTabs, not both' })
      return
    }
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }
      const taskId = task.row.id

      let tabId: string | null = taskId
      if (body.allTabs) tabId = null
      else if (body.tab !== undefined) {
        const tab = await resolveTab(deps, taskId, body.tab)
        if ('error' in tab) {
          res.status(400).json({ ok: false, error: tab.error })
          return
        }
        tabId = tab.id
      }

      const reset = await resetConversation(db, {
        taskId,
        ...(body.mode ? { mode: body.mode } : {}),
        scope: tabId === null ? 'all-tabs' : { tabId }
      })
      res.json({ ok: true, data: { id: taskId, tab: tabId ?? 'all', reset } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

/** One terminal tab of `taskId` named by id, unique id prefix, or unique label. */
async function resolveTab(
  deps: RestApiDeps,
  taskId: string,
  ref: string
): Promise<{ id: string } | { error: string }> {
  const tabs = await deps.db.all<{ id: string; label: string | null; is_main: number }>(
    'SELECT id, label, is_main FROM terminal_tabs WHERE task_id = ?',
    [taskId]
  )
  const exact = tabs.find((t) => t.id === ref)
  if (exact) return { id: exact.id }
  const byPrefix = tabs.filter((t) => t.id.startsWith(ref))
  if (byPrefix.length === 1) return { id: byPrefix[0].id }
  const byLabel = tabs.filter((t) => (t.label ?? (t.is_main ? 'Main' : '')) === ref)
  if (byLabel.length === 1) return { id: byLabel[0].id }
  if (byPrefix.length > 1 || byLabel.length > 1)
    return { error: `Tab "${ref}" is ambiguous in this task` }
  return { error: `No tab "${ref}" in this task` }
}
