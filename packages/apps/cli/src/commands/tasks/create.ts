import crypto from 'crypto'
import { openDb, notifyApp, resolveProject, resolveProjectArg } from '../../db'
import { getDefaultStatus, resolveStatusId } from '@slayzone/projects/shared'
import {
  buildProviderConfig,
  getProjectColumnsConfig,
  mergeTemplateProviderConfig,
  resolveTaskTemplate,
} from './_shared'

export interface CreateOpts {
  project?: string
  description?: string
  status?: string
  priority?: string
  due?: string
  template?: string
  externalId?: string
  externalProvider?: string
}

export async function createAction(title: string, opts: CreateOpts): Promise<void> {
  const db = openDb()
  const project = resolveProject(db, resolveProjectArg(opts.project))

  if (opts.externalId) {
    const existing = db.query<{ id: string; title: string; status: string }>(
      `SELECT id, title, status FROM tasks
       WHERE project_id = :projectId AND external_provider = :provider AND external_id = :externalId
       LIMIT 1`,
      { ':projectId': project.id, ':provider': opts.externalProvider ?? null, ':externalId': opts.externalId }
    )
    if (existing.length > 0) {
      const t = existing[0]
      db.close()
      console.log(`Exists: ${t.id.slice(0, 8)}  ${t.title}  [${t.status}]  ${project.name}`)
      return
    }
  }

  // Resolve template
  const template = resolveTaskTemplate(db, project.id, opts.template)

  if (opts.priority) {
    const p = parseInt(opts.priority, 10)
    if (isNaN(p) || p < 1 || p > 5) { console.error('Priority must be 1-5.'); process.exit(1) }
  }
  const effectivePriority = opts.priority
    ? parseInt(opts.priority, 10)
    : (template?.default_priority ?? 3)

  const projectColumns = getProjectColumnsConfig(db, project.id)
  const status = opts.status
    ? resolveStatusId(opts.status, projectColumns)
    : (template?.default_status
      ? (resolveStatusId(template.default_status, projectColumns) ?? getDefaultStatus(projectColumns))
      : getDefaultStatus(projectColumns))
  if (opts.status && !status) {
    console.error(`Unknown status "${opts.status}" for project "${project.name}".`)
    process.exit(1)
  }

  const terminalMode = template?.terminal_mode
    ?? db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'default_terminal_mode' LIMIT 1`)[0]?.value
    ?? 'claude-code'

  const providerConfig = mergeTemplateProviderConfig(buildProviderConfig(db), template)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    db.run(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, due_date, terminal_mode, provider_config,
         claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
         external_id, external_provider,
         "order", created_at, updated_at)
       VALUES (:id, :projectId, :title, :description, :status, :priority, :dueDate, :terminalMode, :providerConfig,
         :claudeFlags, :codexFlags, :cursorFlags, :geminiFlags, :opencodeFlags,
         :externalId, :externalProvider,
         (SELECT COALESCE(MAX("order"), 0) + 1 FROM tasks WHERE project_id = :projectId),
         :now, :now)`,
      {
        ':id': id,
        ':projectId': project.id,
        ':title': title,
        ':description': opts.description ?? null,
        ':status': status,
        ':priority': effectivePriority,
        ':dueDate': opts.due ?? null,
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
        { ':projectId': project.id, ':provider': opts.externalProvider ?? null, ':externalId': opts.externalId }
      )
      if (existing.length > 0) {
        const t = existing[0]
        db.close()
        console.log(`Exists: ${t.id.slice(0, 8)}  ${t.title}  [${t.status}]  ${project.name}`)
        return
      }
    }
    throw err
  }

  db.close()
  await notifyApp()
  console.log(`Created: ${id.slice(0, 8)}  ${title}  [${status}]  ${project.name}`)
}
