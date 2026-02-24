import fs from 'fs'
import path from 'path'
import type { Database } from 'better-sqlite3'
import type { ProviderConfig, Task } from '@slayzone/task/shared'
import { PROVIDER_DEFAULTS } from '@slayzone/task/shared'

interface ProjectStorageRow {
  path: string | null
  task_storage: string | null
}

interface RawFileTask {
  id: string
  title: string
  description: string | null
  status: string
  priority: number
  order: number
  assignee: string | null
  due_date: string | null
  parent_id: string | null
  archived_at: string | null
  terminal_mode: string
  terminal_shell: string | null
  provider_config: ProviderConfig
  dangerously_skip_permissions: boolean
  panel_visibility: unknown
  worktree_path: string | null
  worktree_parent_branch: string | null
  browser_url: string | null
  browser_tabs: unknown
  web_panel_urls: unknown
  web_panel_resolutions: unknown
  editor_open_files: unknown
  merge_state: string | null
  merge_context: unknown
  is_temporary: boolean
  created_at: string
  updated_at: string
}

const TASKS_RELATIVE_DIR = path.join('docs', 'tasks')
const REPOSITORY_TASK_STORAGE = 'repository'

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function getProjectStorage(db: Database, projectId: string): ProjectStorageRow | null {
  const row = db
    .prepare('SELECT path, task_storage FROM projects WHERE id = ?')
    .get(projectId) as ProjectStorageRow | undefined
  return row ?? null
}

function isRepositoryTaskStorage(project: ProjectStorageRow | null): boolean {
  return project?.task_storage === REPOSITORY_TASK_STORAGE
}

function getTasksDirectory(projectPath: string): string {
  return path.join(projectPath, TASKS_RELATIVE_DIR)
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (lower === '1' || lower === 'true') return true
    if (lower === '0' || lower === 'false') return false
  }
  return fallback
}

function getTaskJsonPath(projectPath: string, taskId: string): string {
  return path.join(getTasksDirectory(projectPath), `${taskId}.json`)
}

export function buildDefaultProviderConfig(
  db: Database,
  overrides?: Record<string, string | undefined>
): ProviderConfig {
  const providerConfig: ProviderConfig = {}
  for (const [mode, def] of Object.entries(PROVIDER_DEFAULTS)) {
    const setting = (db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(def.settingsKey) as { value: string } | undefined)?.value
    providerConfig[mode] = { flags: overrides?.[mode] ?? setting ?? def.fallback }
  }
  return providerConfig
}

function buildProviderConfigFromMetadata(
  metadata: Record<string, unknown>,
  defaultProviderConfig: ProviderConfig
): ProviderConfig {
  const merged: ProviderConfig = {}
  for (const [mode, entry] of Object.entries(defaultProviderConfig)) {
    merged[mode] = { ...entry }
  }

  const rawConfig = safeJsonParse(metadata.provider_config)
  if (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    for (const [mode, entry] of Object.entries(rawConfig as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const normalized = entry as { conversationId?: unknown; flags?: unknown }
        merged[mode] = {
          ...merged[mode],
          ...(normalized.conversationId !== undefined
            ? { conversationId: normalized.conversationId as string | null }
            : {}),
          ...(normalized.flags !== undefined
            ? { flags: typeof normalized.flags === 'string' ? normalized.flags : '' }
            : {})
        }
      }
    }
  }

  const legacyFlagMappings: Array<{ mode: string; key: string }> = [
    { mode: 'claude-code', key: 'claude_flags' },
    { mode: 'codex', key: 'codex_flags' },
    { mode: 'cursor-agent', key: 'cursor_flags' },
    { mode: 'gemini', key: 'gemini_flags' },
    { mode: 'opencode', key: 'opencode_flags' }
  ]
  for (const mapping of legacyFlagMappings) {
    const override = toNullableString(metadata[mapping.key])
    if (override !== null) {
      merged[mapping.mode] = { ...merged[mapping.mode], flags: override }
    }
  }

  return merged
}

function readTaskFilesFromDirectory(
  tasksDir: string,
  defaultTerminalMode: string,
  defaultProviderConfig: ProviderConfig
): RawFileTask[] {
  if (!fs.existsSync(tasksDir)) return []

  const files = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  const rawTasks: RawFileTask[] = []
  const seenTaskIds = new Set<string>()
  const now = new Date().toISOString()

  for (const fileName of files) {
    const filePath = path.join(tasksDir, fileName)
    const fileBase = path.basename(fileName, '.json')

    let metadata: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      }
    } catch (error) {
      console.error(`Failed parsing task file ${filePath}`, error)
      continue
    }

    const id = toNullableString(metadata.id) ?? fileBase
    if (seenTaskIds.has(id)) continue
    seenTaskIds.add(id)

    const providerConfig = buildProviderConfigFromMetadata(metadata, defaultProviderConfig)
    rawTasks.push({
      id,
      title: toNullableString(metadata.title) ?? fileBase,
      description: toNullableString(metadata.description),
      status: toNullableString(metadata.status) ?? 'inbox',
      priority: toNumber(metadata.priority, 3),
      order: toNumber(metadata.order, rawTasks.length),
      assignee: toNullableString(metadata.assignee),
      due_date: toNullableString(metadata.due_date),
      parent_id: toNullableString(metadata.parent_id),
      archived_at: toNullableString(metadata.archived_at),
      terminal_mode: toNullableString(metadata.terminal_mode) ?? defaultTerminalMode,
      terminal_shell: toNullableString(metadata.terminal_shell),
      provider_config: providerConfig,
      dangerously_skip_permissions: toBoolean(metadata.dangerously_skip_permissions, false),
      panel_visibility: safeJsonParse(metadata.panel_visibility),
      worktree_path: toNullableString(metadata.worktree_path),
      worktree_parent_branch: toNullableString(metadata.worktree_parent_branch),
      browser_url: toNullableString(metadata.browser_url),
      browser_tabs: safeJsonParse(metadata.browser_tabs),
      web_panel_urls: safeJsonParse(metadata.web_panel_urls),
      web_panel_resolutions: safeJsonParse(metadata.web_panel_resolutions),
      editor_open_files: safeJsonParse(metadata.editor_open_files),
      merge_state: toNullableString(metadata.merge_state),
      merge_context: safeJsonParse(metadata.merge_context),
      is_temporary: toBoolean(metadata.is_temporary, false),
      created_at: toNullableString(metadata.created_at) ?? now,
      updated_at: toNullableString(metadata.updated_at) ?? now
    })
  }

  return rawTasks
}

export function syncProjectTasksFromFilesystem(db: Database, projectId: string): void {
  const project = getProjectStorage(db, projectId)
  if (!project?.path || !isRepositoryTaskStorage(project)) return

  const tasksDir = getTasksDirectory(project.path)
  if (!fs.existsSync(tasksDir)) return

  const defaultTerminalMode =
    ((db.prepare("SELECT value FROM settings WHERE key = 'default_terminal_mode'").get() as
      | { value: string }
      | undefined)?.value) ?? 'claude-code'
  const defaultProviderConfig = buildDefaultProviderConfig(db)
  const tasks = readTaskFilesFromDirectory(tasksDir, defaultTerminalMode, defaultProviderConfig)
  if (tasks.length === 0) return

  const upsert = db.prepare(`
    INSERT INTO tasks (
      id, project_id, parent_id, title, description, assignee, status, priority, "order",
      due_date, archived_at, terminal_mode, terminal_shell, provider_config,
      claude_conversation_id, codex_conversation_id, cursor_conversation_id, gemini_conversation_id, opencode_conversation_id,
      claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
      dangerously_skip_permissions, panel_visibility, worktree_path, worktree_parent_branch,
      browser_url, browser_tabs, web_panel_urls, web_panel_resolutions, editor_open_files,
      merge_state, merge_context, is_temporary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      parent_id = excluded.parent_id,
      title = excluded.title,
      description = excluded.description,
      assignee = excluded.assignee,
      status = excluded.status,
      priority = excluded.priority,
      "order" = excluded."order",
      due_date = excluded.due_date,
      archived_at = excluded.archived_at,
      terminal_mode = excluded.terminal_mode,
      terminal_shell = excluded.terminal_shell,
      provider_config = excluded.provider_config,
      claude_conversation_id = excluded.claude_conversation_id,
      codex_conversation_id = excluded.codex_conversation_id,
      cursor_conversation_id = excluded.cursor_conversation_id,
      gemini_conversation_id = excluded.gemini_conversation_id,
      opencode_conversation_id = excluded.opencode_conversation_id,
      claude_flags = excluded.claude_flags,
      codex_flags = excluded.codex_flags,
      cursor_flags = excluded.cursor_flags,
      gemini_flags = excluded.gemini_flags,
      opencode_flags = excluded.opencode_flags,
      dangerously_skip_permissions = excluded.dangerously_skip_permissions,
      panel_visibility = excluded.panel_visibility,
      worktree_path = excluded.worktree_path,
      worktree_parent_branch = excluded.worktree_parent_branch,
      browser_url = excluded.browser_url,
      browser_tabs = excluded.browser_tabs,
      web_panel_urls = excluded.web_panel_urls,
      web_panel_resolutions = excluded.web_panel_resolutions,
      editor_open_files = excluded.editor_open_files,
      merge_state = excluded.merge_state,
      merge_context = excluded.merge_context,
      is_temporary = excluded.is_temporary,
      updated_at = excluded.updated_at
  `)

  db.transaction(() => {
    for (const task of tasks) {
      upsert.run(
        task.id,
        projectId,
        null,
        task.title,
        task.description,
        task.assignee,
        task.status,
        task.priority,
        task.order,
        task.due_date,
        task.archived_at,
        task.terminal_mode,
        task.terminal_shell,
        JSON.stringify(task.provider_config),
        task.provider_config['claude-code']?.conversationId ?? null,
        task.provider_config['codex']?.conversationId ?? null,
        task.provider_config['cursor-agent']?.conversationId ?? null,
        task.provider_config['gemini']?.conversationId ?? null,
        task.provider_config['opencode']?.conversationId ?? null,
        task.provider_config['claude-code']?.flags ?? '',
        task.provider_config['codex']?.flags ?? '',
        task.provider_config['cursor-agent']?.flags ?? '',
        task.provider_config['gemini']?.flags ?? '',
        task.provider_config['opencode']?.flags ?? '',
        task.dangerously_skip_permissions ? 1 : 0,
        task.panel_visibility ? JSON.stringify(task.panel_visibility) : null,
        task.worktree_path,
        task.worktree_parent_branch,
        task.browser_url,
        task.browser_tabs ? JSON.stringify(task.browser_tabs) : null,
        task.web_panel_urls ? JSON.stringify(task.web_panel_urls) : null,
        task.web_panel_resolutions ? JSON.stringify(task.web_panel_resolutions) : null,
        task.editor_open_files ? JSON.stringify(task.editor_open_files) : null,
        task.merge_state,
        task.merge_context ? JSON.stringify(task.merge_context) : null,
        task.is_temporary ? 1 : 0,
        task.created_at,
        task.updated_at
      )
    }

    const linkParent = db.prepare(`
      UPDATE tasks
      SET parent_id = ?
      WHERE id = ?
        AND EXISTS (SELECT 1 FROM tasks parent WHERE parent.id = ?)
    `)

    for (const task of tasks) {
      if (!task.parent_id) continue
      linkParent.run(task.parent_id, task.id, task.parent_id)
    }
  })()
}

export function writeTaskToFilesystem(db: Database, task: Task): void {
  const project = getProjectStorage(db, task.project_id)
  if (!project?.path || !isRepositoryTaskStorage(project)) return

  const tasksDir = getTasksDirectory(project.path)
  fs.mkdirSync(tasksDir, { recursive: true })

  const payload: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    order: task.order,
    assignee: task.assignee,
    due_date: task.due_date,
    parent_id: task.parent_id,
    archived_at: task.archived_at,
    terminal_mode: task.terminal_mode,
    terminal_shell: task.terminal_shell,
    provider_config: task.provider_config,
    dangerously_skip_permissions: task.dangerously_skip_permissions,
    panel_visibility: task.panel_visibility,
    worktree_path: task.worktree_path,
    worktree_parent_branch: task.worktree_parent_branch,
    browser_url: task.browser_url,
    browser_tabs: task.browser_tabs,
    web_panel_urls: task.web_panel_urls,
    web_panel_resolutions: task.web_panel_resolutions,
    editor_open_files: task.editor_open_files,
    merge_state: task.merge_state,
    merge_context: task.merge_context,
    is_temporary: task.is_temporary,
    created_at: task.created_at,
    updated_at: task.updated_at
  }

  fs.writeFileSync(getTaskJsonPath(project.path, task.id), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export function deleteTaskFromFilesystem(
  db: Database,
  taskId: string,
  projectId: string | null | undefined
): void {
  if (!projectId) return
  const project = getProjectStorage(db, projectId)
  if (!project?.path || !isRepositoryTaskStorage(project)) return

  const filePath = getTaskJsonPath(project.path, taskId)
  try {
    fs.unlinkSync(filePath)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') {
      console.error(`Failed deleting task file ${filePath}`, error)
    }
  }
}
