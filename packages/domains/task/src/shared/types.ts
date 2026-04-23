import type { TerminalMode, LoopConfig } from '@slayzone/terminal/shared'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import type { EditorOpenFilesState } from '@slayzone/file-editor/shared'

// Built-in starter statuses used as defaults for new projects.
export const BUILTIN_STATUSES = ['inbox', 'backlog', 'todo', 'in_progress', 'review', 'done', 'canceled'] as const
export const TASK_STATUSES = BUILTIN_STATUSES
export type TaskStatus = string
export type MergeState = 'uncommitted' | 'conflicts' | 'rebase-conflicts'

export interface MergeContext {
  type: 'merge' | 'rebase'
  sourceBranch: string // branch being merged / rebased
  targetBranch: string // branch being merged INTO / rebased ONTO
}

// --- Provider config (JSON column on tasks table) ---

/** Per-provider config stored as JSON in the provider_config column. Key = TerminalMode value. */
export interface ProviderConfig {
  [mode: string]: {
    conversationId?: string | null
    flags?: string
    // Unix-ms timestamp of the last host-initiated PTY kill (e.g. task moved to a
    // terminal status). Used by the revive path to decide whether to resume the
    // prior conversation (hot) or start a fresh one (cold — see COLD_RESPAWN_MS).
    lastPtyKilledAt?: number | null
  }
}

export function getProviderConversationId(cfg: ProviderConfig | undefined | null, mode: string): string | null {
  return cfg?.[mode]?.conversationId ?? null
}

export function getProviderFlags(cfg: ProviderConfig | undefined | null, mode: string): string {
  return cfg?.[mode]?.flags ?? ''
}

export function getProviderLastKilledAt(cfg: ProviderConfig | undefined | null, mode: string): number | null {
  return cfg?.[mode]?.lastPtyKilledAt ?? null
}

export function setProviderConversationId(cfg: ProviderConfig | undefined | null, mode: string, val: string | null): ProviderConfig {
  return { ...cfg, [mode]: { ...cfg?.[mode], conversationId: val } }
}

export function setProviderFlags(cfg: ProviderConfig | undefined | null, mode: string, val: string): ProviderConfig {
  return { ...cfg, [mode]: { ...cfg?.[mode], flags: val } }
}

export function setProviderLastKilledAt(cfg: ProviderConfig | undefined | null, mode: string, val: number | null): ProviderConfig {
  return { ...cfg, [mode]: { ...cfg?.[mode], lastPtyKilledAt: val } }
}

/** Threshold past which a revive should start a fresh AI conversation rather than
 *  resume the previous one. Keeps hot-bounces seamless while avoiding stale context
 *  days later. */
export const COLD_RESPAWN_MS = 30 * 60 * 1000

/** Returns a partial ProviderConfig that sets conversationId=null for all modes in cfg.
 *  Does NOT include flags — the handler deep-merges, so existing flags survive. */
export function clearAllConversationIds(cfg: ProviderConfig | undefined | null): ProviderConfig {
  const result: ProviderConfig = {}
  for (const mode of Object.keys(cfg ?? {})) {
    result[mode] = { conversationId: null }
  }
  return result
}

export interface PanelVisibility extends Record<string, boolean> {
  terminal: boolean
  browser: boolean
  diff: boolean
  settings: boolean
  editor: boolean
  assets: boolean
  processes: boolean
}

export interface DesktopHandoffPolicy {
  // URL protocol without :// (for example "figma", "slack", "notion")
  protocol: string
  // Optional host/domain guard to avoid overblocking unrelated popup URLs.
  hostScope?: string
}

// Web panel definition (custom or predefined)
export interface WebPanelDefinition {
  id: string           // 'web:<uuid>' for custom, 'web:figma' for predefined
  name: string
  baseUrl: string
  shortcut?: string    // single letter, e.g. 'm' → Cmd+M
  predefined?: boolean // true = shipped with app (can still be deleted)
  favicon?: string     // cached favicon URL
  // Legacy toggle. Prefer handoffProtocol + handoffHostScope.
  blockDesktopHandoff?: boolean
  // Custom protocol to block in encoded desktop-handoff URLs (for example "figma").
  handoffProtocol?: string
  // Optional host/domain guard used when evaluating encoded desktop-handoff URLs.
  handoffHostScope?: string
}

// Which view a panel belongs to
export type PanelView = 'home' | 'task'

// Global panel config (stored in settings table as JSON)
export interface PanelConfig {
  viewEnabled: Partial<Record<PanelView, Record<string, boolean>>>
  webPanels: WebPanelDefinition[]
  deletedPredefined?: string[] // IDs of predefined panels the user removed
}

/** Check if a panel is enabled for a specific view. Defaults to true if not set. */
export function isPanelEnabled(config: PanelConfig, id: string, view: PanelView): boolean {
  return config.viewEnabled?.[view]?.[id] !== false
}

// Per-task URL state (panelId → current URL)
export type WebPanelUrls = Record<string, string>

export const BUILTIN_PANEL_IDS = ['terminal', 'browser', 'editor', 'assets', 'diff', 'settings', 'processes'] as const

export const PREDEFINED_WEB_PANELS: WebPanelDefinition[] = [
  {
    id: 'web:figma',
    name: 'Figma',
    baseUrl: 'https://figma.com',
    shortcut: 'y',
    predefined: true,
    blockDesktopHandoff: true,
    handoffProtocol: 'figma',
    handoffHostScope: 'figma.com',
  },
  { id: 'web:notion', name: 'Notion', baseUrl: 'https://notion.so', shortcut: 'n', predefined: true },
  { id: 'web:github', name: 'GitHub', baseUrl: 'https://github.com', shortcut: 'h', predefined: true },
  { id: 'web:excalidraw', name: 'Excalidraw', baseUrl: 'https://excalidraw.com', shortcut: 'x', predefined: true },
  { id: 'web:monosketch', name: 'Monosketch', baseUrl: 'https://app.monosketch.io', shortcut: 'u', predefined: true }
]

export const DEFAULT_PANEL_CONFIG: PanelConfig = {
  viewEnabled: {
    home: { git: true, editor: true, processes: true, tests: true, automations: true },
    task: {
      ...Object.fromEntries(BUILTIN_PANEL_IDS.map(id => [id, true])),
      ...Object.fromEntries(PREDEFINED_WEB_PANELS.map(wp => [wp.id, false]))
    },
  },
  webPanels: [...PREDEFINED_WEB_PANELS]
}

// --- Task Assets ---

export type RenderMode = 'markdown' | 'code' | 'html-preview' | 'svg-preview' | 'mermaid-preview' | 'image' | 'pdf'

/** Maps file extensions → default render mode. Unlisted extensions default to 'code'. */
export const EXTENSION_RENDER_MODES: Record<string, RenderMode> = {
  '.md': 'markdown', '.mdx': 'markdown',
  '.html': 'html-preview', '.htm': 'html-preview',
  '.svg': 'svg-preview',
  '.mmd': 'mermaid-preview', '.mermaid': 'mermaid-preview',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  '.gif': 'image', '.webp': 'image', '.avif': 'image', '.bmp': 'image',
  '.pdf': 'pdf',
}

export const RENDER_MODE_INFO: Record<RenderMode, { label: string }> = {
  'markdown': { label: 'Rich Text' },
  'code': { label: 'Code' },
  'html-preview': { label: 'HTML Preview' },
  'svg-preview': { label: 'SVG Preview' },
  'mermaid-preview': { label: 'Mermaid Preview' },
  'image': { label: 'Image' },
  'pdf': { label: 'PDF' },
}

/** Whether a render mode represents a binary (non-text) asset. */
export function isBinaryRenderMode(mode: RenderMode): boolean {
  return mode === 'image' || mode === 'pdf'
}

/** Render modes that support "Download as PDF" conversion. */
export function canExportAsPdf(mode: RenderMode): boolean {
  return mode === 'markdown' || mode === 'code' || mode === 'html-preview' || mode === 'svg-preview' || mode === 'mermaid-preview'
}

/** Render modes that support "Download as PNG" capture. */
export function canExportAsPng(mode: RenderMode): boolean {
  return mode === 'svg-preview' || mode === 'mermaid-preview'
}

/** Render modes that support "Download as HTML" export. */
export function canExportAsHtml(mode: RenderMode): boolean {
  return mode === 'markdown' || mode === 'code' || mode === 'mermaid-preview'
}

/** Extract file extension from title (e.g. "notes.md" → ".md"). Empty string if none. */
export function getExtensionFromTitle(title: string): string {
  const dot = title.lastIndexOf('.')
  if (dot <= 0) return ''
  return title.slice(dot).toLowerCase()
}

/** Determine effective render mode: use override if set, else infer from extension. */
export function getEffectiveRenderMode(title: string, override: RenderMode | null): RenderMode {
  if (override) return override
  return EXTENSION_RENDER_MODES[getExtensionFromTitle(title)] ?? 'code'
}

export interface TaskAsset {
  id: string
  task_id: string
  folder_id: string | null
  title: string
  render_mode: RenderMode | null
  view_mode: string | null
  readability_override: 'compact' | 'normal' | null
  width_override: 'narrow' | 'wide' | null
  language: string | null
  order: number
  created_at: string
  updated_at: string
  current_version_id: string | null
}

export interface CreateAssetInput {
  taskId: string
  title: string
  folderId?: string | null
  renderMode?: RenderMode
  content?: string
  language?: string | null
}

export interface UpdateAssetInput {
  id: string
  title?: string
  folderId?: string | null
  renderMode?: RenderMode | null
  viewMode?: string | null
  readabilityOverride?: 'compact' | 'normal' | null
  widthOverride?: 'narrow' | 'wide' | null
  content?: string
  language?: string | null
}

export interface AssetFolder {
  id: string
  task_id: string
  parent_id: string | null
  name: string
  order: number
  created_at: string
}

export interface CreateAssetFolderInput {
  taskId: string
  name: string
  parentId?: string | null
}

export interface UpdateAssetFolderInput {
  id: string
  name?: string
  parentId?: string | null
}

export interface Task {
  id: string
  project_id: string
  parent_id: string | null
  title: string
  description: string | null
  description_format: 'html' | 'markdown'
  assignee: string | null
  status: TaskStatus
  priority: number // 1-5, default 3
  progress: number // 0-100, default 0
  order: number
  due_date: string | null
  archived_at: string | null
  // Terminal configuration
  terminal_mode: TerminalMode
  provider_config: ProviderConfig
  terminal_shell: string | null
  // @deprecated — use provider_config[mode].conversationId
  claude_conversation_id: string | null
  codex_conversation_id: string | null
  cursor_conversation_id: string | null
  gemini_conversation_id: string | null
  opencode_conversation_id: string | null
  // @deprecated — use provider_config[mode].flags
  claude_flags: string
  codex_flags: string
  cursor_flags: string
  gemini_flags: string
  opencode_flags: string
  // Permissions
  dangerously_skip_permissions: boolean
  // Panel visibility (JSON)
  panel_visibility: PanelVisibility | null
  // Worktree
  worktree_path: string | null
  worktree_parent_branch: string | null
  // Transient — populated by main handlers from worktree color-registry. NOT a DB column.
  worktree_color?: string | null
  // Custom working directory (overrides project.path, overridden by worktree_path)
  base_dir: string | null
  browser_url: string | null
  // Browser tabs (JSON)
  browser_tabs: BrowserTabsState | null
  // Web panel URLs (JSON) — per-task persistent URLs for custom/predefined web panels
  web_panel_urls: WebPanelUrls | null
  // Editor panel state (JSON)
  editor_open_files: EditorOpenFilesState | null
  // Merge mode
  merge_state: MergeState | null
  merge_context: MergeContext | null
  // CCS (Claude Code Switch) profile name
  ccs_profile: string | null
  // Loop mode configuration (JSON)
  loop_config: LoopConfig | null
  // Snooze — task hidden from board until this datetime (ISO 8601)
  snoozed_until: string | null
  // Temporary task (ephemeral terminal tab, deleted on close)
  is_temporary: boolean
  // Standalone blocked flag (independent of task_dependencies)
  is_blocked: boolean
  blocked_comment: string | null
  // Pull request
  pr_url: string | null
  // Active asset selection (persisted across task switches)
  active_asset_id: string | null
  // Multi-repo: folder name of the child repo this task is scoped to
  repo_name: string | null
  // External link (populated via JOIN)
  linear_url: string | null
  // Orchestrator (subtask manager) sidebar toggle state, persisted per task
  manager_mode: boolean
  created_at: string
  updated_at: string
}

export interface TaskDependency {
  task_id: string
  blocks_task_id: string
}

export interface CreateTaskDraft {
  projectId?: string
  title?: string
  description?: string
  status?: TaskStatus
  priority?: number
  dueDate?: string | null
}

export interface CreateTaskInput {
  projectId: string
  title: string
  description?: string
  assignee?: string | null
  status?: string
  priority?: number
  dueDate?: string
  terminalMode?: TerminalMode
  claudeFlags?: string
  codexFlags?: string
  cursorFlags?: string
  geminiFlags?: string
  opencodeFlags?: string
  parentId?: string
  isTemporary?: boolean
  repoName?: string | null
  templateId?: string
}

export interface UpdateTaskInput {
  id: string
  title?: string
  description?: string | null
  assignee?: string | null
  status?: string
  priority?: number
  progress?: number
  dueDate?: string | null
  projectId?: string
  // Terminal config
  terminalMode?: TerminalMode
  providerConfig?: ProviderConfig
  terminalShell?: string | null
  // @deprecated — use providerConfig
  claudeConversationId?: string | null
  codexConversationId?: string | null
  cursorConversationId?: string | null
  geminiConversationId?: string | null
  opencodeConversationId?: string | null
  claudeFlags?: string
  codexFlags?: string
  cursorFlags?: string
  geminiFlags?: string
  opencodeFlags?: string
  // Panel visibility
  panelVisibility?: PanelVisibility | null
  // Worktree
  worktreePath?: string | null
  worktreeParentBranch?: string | null
  // Custom working directory
  baseDir?: string | null
  browserUrl?: string | null
  // Browser tabs
  browserTabs?: BrowserTabsState | null
  // Web panel URLs
  webPanelUrls?: WebPanelUrls | null
  // Editor state
  editorOpenFiles?: EditorOpenFilesState | null
  // Merge mode
  mergeState?: MergeState | null
  mergeContext?: MergeContext | null
  // Loop mode
  loopConfig?: LoopConfig | null
  // Snooze
  snoozedUntil?: string | null
  // Pull request
  prUrl?: string | null
  // Temporary task
  isTemporary?: boolean
  // Orchestrator sidebar toggle state
  managerMode?: boolean
  // Blocked
  isBlocked?: boolean
  blockedComment?: string | null
  // Active asset
  activeAssetId?: string | null
  // Multi-repo
  repoName?: string | null
  // Reparent: undefined = no change, null = detach to root, string = new parent id
  parentId?: string | null
}
