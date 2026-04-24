import crypto from 'crypto'
import { openDb, notifyApp } from '../../db'
import { getDefaultStatus, resolveStatusId } from '@slayzone/projects/shared'
import { buildProviderConfig, getProjectColumnsConfig, resolveId } from './_shared'

export interface SubtaskAddOpts {
  parent?: string
  description?: string
  status?: string
  priority?: string
  externalId?: string
  externalProvider?: string
}

export async function subtaskAddAction(title: string, opts: SubtaskAddOpts): Promise<void> {
  const parentId = resolveId(opts.parent)
  const db = openDb()

  const parents = db.query<{ id: string; project_id: string; terminal_mode: string | null }>(
    `SELECT id, project_id, terminal_mode FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': parentId }
  )

  if (parents.length === 0) { console.error(`Task not found: ${parentId}`); process.exit(1) }
  if (parents.length > 1) {
    console.error(`Ambiguous id prefix "${parentId}". Matches: ${parents.map((t) => t.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }

  const parent = parents[0]

  if (opts.externalId) {
    const existing = db.query<{ id: string; title: string; status: string }>(
      `SELECT id, title, status FROM tasks
       WHERE project_id = :projectId AND external_provider = :provider AND external_id = :externalId
       LIMIT 1`,
      { ':projectId': parent.project_id, ':provider': opts.externalProvider ?? null, ':externalId': opts.externalId }
    )
    if (existing.length > 0) {
      const t = existing[0]
      db.close()
      console.log(`Exists: ${t.id.slice(0, 8)}  ${t.title}  [${t.status}]`)
      return
    }
  }

  const priority = parseInt(opts.priority ?? '3', 10)
  if (isNaN(priority) || priority < 1 || priority > 5) {
    console.error('Priority must be 1-5.')
    process.exit(1)
  }
  const parentColumns = getProjectColumnsConfig(db, parent.project_id)
  const status = opts.status ? resolveStatusId(opts.status, parentColumns) : getDefaultStatus(parentColumns)
  if (opts.status && !status) {
    console.error(`Unknown status "${opts.status}" for parent task's project.`)
    process.exit(1)
  }

  const terminalMode = parent.terminal_mode
    ?? (db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'default_terminal_mode' LIMIT 1`)[0]?.value)
    ?? 'claude-code'

  const providerConfig = buildProviderConfig(db)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    db.run(
      `INSERT INTO tasks (id, project_id, parent_id, title, description, status, priority, terminal_mode, provider_config,
         claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
         external_id, external_provider,
         "order", created_at, updated_at, is_temporary)
       VALUES (:id, :projectId, :parentId, :title, :description, :status, :priority, :terminalMode, :providerConfig,
         :claudeFlags, :codexFlags, :cursorFlags, :geminiFlags, :opencodeFlags,
         :externalId, :externalProvider,
         (SELECT COALESCE(MAX("order"), 0) + 1 FROM tasks WHERE project_id = :projectId),
         :now, :now, 0)`,
      {
        ':id': id,
        ':projectId': parent.project_id,
        ':parentId': parent.id,
        ':title': title,
        ':description': opts.description ?? null,
        ':status': status,
        ':priority': priority,
        ':terminalMode': terminalMode,
        ':providerConfig': JSON.stringify(providerConfig),
        ':claudeFlags': providerConfig['claude-code']?.flags ?? '',
        ':codexFlags': providerConfig['codex']?.flags ?? '',
        ':cursorFlags': providerConfig['cursor-agent']?.flags ?? '',
        ':geminiFlags': providerConfig['gemini']?.flags ?? '',
        ':opencodeFlags': providerConfig['opencode']?.flags ?? '',
        ':externalId': opts.externalId ?? null,
        ':externalProvider': opts.externalId ? (opts.externalProvider ?? null) : null,
        ':now': now,
      }
    )
  } catch (err: unknown) {
    if (opts.externalId && err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      const existing = db.query<{ id: string; title: string; status: string }>(
        `SELECT id, title, status FROM tasks
         WHERE project_id = :projectId AND external_provider = :provider AND external_id = :externalId
         LIMIT 1`,
        { ':projectId': parent.project_id, ':provider': opts.externalProvider ?? null, ':externalId': opts.externalId }
      )
      if (existing.length > 0) {
        const t = existing[0]
        db.close()
        console.log(`Exists: ${t.id.slice(0, 8)}  ${t.title}  [${t.status}]`)
        return
      }
    }
    throw err
  }

  db.close()
  await notifyApp()
  console.log(`Created subtask: ${id.slice(0, 8)}  ${title}`)
}
