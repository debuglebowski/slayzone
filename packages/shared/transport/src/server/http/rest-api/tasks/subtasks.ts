import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import {
  getDefaultStatus,
  parseColumnsConfig,
  resolveStatusId
} from '@slayzone/projects/shared'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * GET  /api/tasks/:id/subtasks — list direct subtasks (CLI `slay tasks subtasks`).
 * POST /api/tasks/:id/subtasks — create a subtask (CLI `slay tasks subtask-add`):
 * inherits the parent's project + terminal mode (falling back to the
 * `default_terminal_mode` setting, then 'claude-code'), snapshots the current
 * provider flag config, supports external-id dedupe (returns the existing row
 * with `existing: true` instead of erroring).
 */

interface ParentRow {
  id: string
  project_id: string
  terminal_mode: string | null
}

async function buildProviderConfig(
  db: RestApiDeps['db']
): Promise<Record<string, { flags: string }>> {
  let rows: { id: string; default_flags: string | null }[] = []
  try {
    rows = await db.all(`SELECT id, default_flags FROM terminal_modes WHERE enabled = 1`)
  } catch {
    /* table may not exist */
  }
  if (rows.length === 0) {
    rows = DEFAULT_TERMINAL_MODES.filter((m) => m.enabled).map((m) => ({
      id: m.id,
      default_flags: m.defaultFlags ?? ''
    }))
  }
  const config: Record<string, { flags: string }> = {}
  for (const row of rows) {
    config[row.id] = { flags: row.default_flags ?? '' }
  }
  return config
}

export function registerTaskSubtasksRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks/:id/subtasks', async (req, res) => {
    try {
      const db = deps.db
      const parent = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(parent)) {
        res.status(parent.status).json({ ok: false, error: parent.error })
        return
      }
      const tasks = await db.all(
        `SELECT t.id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
         FROM tasks t JOIN projects p ON t.project_id = p.id
         WHERE t.parent_id = ? AND t.archived_at IS NULL AND t.deleted_at IS NULL
         ORDER BY t."order" ASC`,
        [parent.row.id]
      )
      res.json({ ok: true, data: tasks })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/tasks/:id/subtasks', async (req, res) => {
    const body = (req.body ?? {}) as {
      title?: unknown
      description?: unknown
      status?: unknown
      priority?: unknown
      externalId?: unknown
      externalProvider?: unknown
    }
    if (typeof body.title !== 'string' || !body.title.trim()) {
      res.status(400).json({ ok: false, error: 'title required' })
      return
    }
    const priority =
      body.priority === undefined ? 3 : parseInt(String(body.priority), 10)
    if (isNaN(priority) || priority < 1 || priority > 5) {
      res.status(400).json({ ok: false, error: 'Priority must be 1-5.' })
      return
    }
    const externalId = typeof body.externalId === 'string' ? body.externalId : undefined
    const externalProvider =
      typeof body.externalProvider === 'string' ? body.externalProvider : undefined

    try {
      const db = deps.db
      const resolved = await resolveByIdPrefix<ParentRow>(
        db,
        'tasks',
        req.params.id,
        'Task',
        'id, project_id, terminal_mode'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const parent = resolved.row

      const findExisting = async (): Promise<Record<string, unknown> | undefined> =>
        db.get<Record<string, unknown>>(
          `SELECT id, title, status FROM tasks
           WHERE project_id = ? AND external_provider = ? AND external_id = ?
           LIMIT 1`,
          [parent.project_id, externalProvider ?? null, externalId]
        )

      if (externalId) {
        const existing = await findExisting()
        if (existing) {
          res.json({ ok: true, data: existing, existing: true })
          return
        }
      }

      const parentColumns = await (async () => {
        const row = await db.get<{ columns_config: string | null }>(
          `SELECT columns_config FROM projects WHERE id = ? LIMIT 1`,
          [parent.project_id]
        )
        return parseColumnsConfig(row?.columns_config ?? null)
      })()
      const requestedStatus = typeof body.status === 'string' ? body.status : undefined
      const status = requestedStatus
        ? resolveStatusId(requestedStatus, parentColumns)
        : getDefaultStatus(parentColumns)
      if (requestedStatus && !status) {
        res.status(400).json({
          ok: false,
          error: `Unknown status "${requestedStatus}" for parent task's project.`
        })
        return
      }

      const terminalMode =
        parent.terminal_mode ??
        (
          await db.get<{ value: string }>(
            `SELECT value FROM settings WHERE key = 'default_terminal_mode' LIMIT 1`
          )
        )?.value ??
        'claude-code'

      const providerConfig = await buildProviderConfig(db)
      const id = randomUUID()
      const now = new Date().toISOString()

      try {
        await db.run(
          `INSERT INTO tasks (id, project_id, parent_id, title, description, status, priority, terminal_mode, provider_config,
             claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
             external_id, external_provider,
             "order", created_at, updated_at, is_temporary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             (SELECT COALESCE(MAX("order"), 0) + 1 FROM tasks WHERE project_id = ?),
             ?, ?, 0)`,
          [
            id,
            parent.project_id,
            parent.id,
            body.title,
            typeof body.description === 'string' ? body.description : null,
            status,
            priority,
            terminalMode,
            JSON.stringify(providerConfig),
            providerConfig['claude-code']?.flags ?? '',
            providerConfig['codex']?.flags ?? '',
            providerConfig['cursor-agent']?.flags ?? '',
            providerConfig['gemini']?.flags ?? '',
            providerConfig['opencode']?.flags ?? '',
            externalId ?? null,
            externalId ? (externalProvider ?? null) : null,
            parent.project_id,
            now,
            now
          ]
        )
      } catch (err) {
        // External-id UNIQUE race: another writer created the same subtask —
        // return theirs (CLI parity).
        if (
          externalId &&
          err instanceof Error &&
          err.message.includes('UNIQUE constraint failed')
        ) {
          const existing = await findExisting()
          if (existing) {
            res.json({ ok: true, data: existing, existing: true })
            return
          }
        }
        throw err
      }

      deps.notifyRenderer()
      const created = await db.get<Record<string, unknown>>(
        `SELECT id, project_id, parent_id, title, description, status, priority, created_at, updated_at
         FROM tasks WHERE id = ?`,
        [id]
      )
      res.json({ ok: true, data: created })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
