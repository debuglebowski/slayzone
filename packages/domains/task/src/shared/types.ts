import type { TerminalMode, LoopConfig } from '@slayzone/terminal/shared'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import type { EditorOpenFilesState } from '@slayzone/file-editor/shared'

// Built-in starter statuses used as defaults for new projects.
export const BUILTIN_STATUSES = ['inbox', 'backlog', 'todo', 'in_progress', 'review', 'done', 'canceled'] as const
export const TASK_STATUSES = BUILTIN_STATUSES
export type TaskStatus = string

// Single-source identifier for the "actively being worked on" status.
// Wrap consumers in `isInProgress(task)` so future per-project status mappings
// only need to update this helper.
export const IN_PROGRESS_STATUS = 'in_progress'
export const isInProgress = (status: TaskStatus | undefined | null): boolean =>
  status === IN_PROGRESS_STATUS
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
  artifacts: boolean
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
  // Unified reorder across home + task views. IDs use settings-modal style:
  // 'terminal', 'browser', 'editor', 'artifacts', 'git', 'settings', 'processes', 'web:*'.
  // 'git' maps to task panel 'diff' and home panel 'git'. Task-only panels are skipped on home.
  order?: string[]
}

/** Check if a panel is enabled for a specific view. Defaults to true if not set. */
export function isPanelEnabled(config: PanelConfig, id: string, view: PanelView): boolean {
  return config.viewEnabled?.[view]?.[id] !== false
}

// Per-task URL state (panelId → current URL)
export type WebPanelUrls = Record<string, string>

export const BUILTIN_PANEL_IDS = ['terminal', 'browser', 'editor', 'artifacts', 'diff', 'settings', 'processes'] as const

// IDs used in PanelConfig.order (settings-modal style). 'git' is the shared row that
// maps to 'diff' on task view and 'git' on home view.
export const PANEL_ORDER_IDS = ['terminal', 'browser', 'editor', 'artifacts', 'git', 'settings', 'processes'] as const
export type PanelOrderId = typeof PANEL_ORDER_IDS[number] | `web:${string}`

/** Map a PanelConfig.order ID to its task-view panel ID. */
export function orderIdToTaskId(id: string): string {
  return id === 'git' ? 'diff' : id
}

/** Map a PanelConfig.order ID to its home-view panel ID, or null if task-only. */
export function orderIdToHomeId(id: string): string | null {
  if (id === 'terminal' || id === 'browser' || id === 'artifacts' || id === 'settings') return null
  return id // 'git', 'editor', 'processes', 'web:*'
}

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

export const DEFAULT_PANEL_ORDER: string[] = [
  'terminal', 'browser', 'editor', 'artifacts', 'git', 'settings', 'processes',
  ...PREDEFINED_WEB_PANELS.map(wp => wp.id),
]

// Git panel sub-tabs (rendered inside UnifiedGitPanel).
export type GitTabId = 'general' | 'changes' | 'conflicts' | 'worktrees' | 'pr' | 'stash'

export const DEFAULT_GIT_TAB_ORDER: readonly GitTabId[] = [
  'general', 'changes', 'stash', 'worktrees', 'conflicts', 'pr',
]

export const GIT_TAB_LABELS: Record<GitTabId, string> = {
  general: 'General',
  changes: 'Diff',
  stash: 'Stash',
  worktrees: 'Worktrees',
  conflicts: 'Conflicts',
  pr: 'Pull request',
}

/** Per-tab enable/disable. Missing key = enabled (default on). */
export type GitTabVisibility = Partial<Record<GitTabId, boolean>>

export function isGitTabEnabled(vis: GitTabVisibility, id: GitTabId): boolean {
  return vis[id] !== false
}

/** Parse persisted `git_tab_visibility` value, tolerating unknown keys. */
export function normalizeGitTabVisibility(raw: string | null | undefined): GitTabVisibility {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: GitTabVisibility = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k in GIT_TAB_LABELS && typeof v === 'boolean') out[k as GitTabId] = v
    }
    return out
  } catch { return {} }
}

/** Parse persisted `git_tab_order` value, tolerating unknown/missing ids. */
export function normalizeGitTabOrder(raw: string | null | undefined): GitTabId[] {
  const fallback = [...DEFAULT_GIT_TAB_ORDER]
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    const seen = new Set<GitTabId>()
    const out: GitTabId[] = []
    for (const v of parsed) {
      if (typeof v === 'string' && v in GIT_TAB_LABELS && !seen.has(v as GitTabId)) {
        seen.add(v as GitTabId)
        out.push(v as GitTabId)
      }
    }
    for (const id of DEFAULT_GIT_TAB_ORDER) if (!seen.has(id)) out.push(id)
    return out
  } catch {
    return fallback
  }
}

export const DEFAULT_PANEL_CONFIG: PanelConfig = {
  viewEnabled: {
    home: { git: true, editor: true, processes: true, tests: true, automations: true },
    task: {
      ...Object.fromEntries(BUILTIN_PANEL_IDS.map(id => [id, true])),
      ...Object.fromEntries(PREDEFINED_WEB_PANELS.map(wp => [wp.id, false]))
    },
  },
  webPanels: [...PREDEFINED_WEB_PANELS],
  order: [...DEFAULT_PANEL_ORDER],
}

// --- Task Artifacts ---

export type RenderMode = 'markdown' | 'code' | 'html-preview' | 'svg-preview' | 'mermaid-preview' | 'image' | 'pdf'

/** Maps file extensions → default render mode. Unlisted/no extension defaults to 'markdown'. */
export const EXTENSION_RENDER_MODES: Record<string, RenderMode> = {
  // Markdown
  '.md': 'markdown', '.mdx': 'markdown', '.markdown': 'markdown',

  // HTML
  '.html': 'html-preview', '.htm': 'html-preview',

  // SVG
  '.svg': 'svg-preview',

  // Mermaid
  '.mmd': 'mermaid-preview', '.mermaid': 'mermaid-preview',

  // Images
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  '.gif': 'image', '.webp': 'image', '.avif': 'image', '.bmp': 'image',
  '.ico': 'image', '.tiff': 'image', '.tif': 'image', '.heic': 'image', '.heif': 'image',

  // PDF
  '.pdf': 'pdf',

  // Code — programming languages
  '.ts': 'code', '.tsx': 'code', '.js': 'code', '.jsx': 'code', '.mjs': 'code', '.cjs': 'code',
  '.py': 'code', '.pyw': 'code',
  '.rs': 'code',
  '.go': 'code',
  '.java': 'code', '.kt': 'code', '.kts': 'code',
  '.c': 'code', '.h': 'code', '.cpp': 'code', '.cc': 'code', '.cxx': 'code', '.hpp': 'code', '.hh': 'code',
  '.cs': 'code',
  '.swift': 'code',
  '.m': 'code', '.mm': 'code',
  '.rb': 'code',
  '.php': 'code',
  '.dart': 'code',
  '.lua': 'code',
  '.r': 'code',
  '.scala': 'code',
  '.clj': 'code', '.cljs': 'code',
  '.ex': 'code', '.exs': 'code',
  '.erl': 'code',
  '.hs': 'code',
  '.ml': 'code', '.mli': 'code',
  '.fs': 'code', '.fsx': 'code',
  '.zig': 'code',
  '.nim': 'code',
  '.sol': 'code',
  '.vue': 'code', '.svelte': 'code', '.astro': 'code',

  // Code — shells
  '.sh': 'code', '.bash': 'code', '.zsh': 'code', '.fish': 'code', '.ps1': 'code', '.bat': 'code', '.cmd': 'code',

  // Code — config / data
  '.json': 'code', '.jsonc': 'code', '.json5': 'code',
  '.yaml': 'code', '.yml': 'code',
  '.toml': 'code',
  '.ini': 'code', '.cfg': 'code', '.conf': 'code',
  '.xml': 'code',
  '.csv': 'code', '.tsv': 'code',
  '.env': 'code',

  // Code — styles
  '.css': 'code', '.scss': 'code', '.sass': 'code', '.less': 'code', '.styl': 'code',

  // Code — queries / schema
  '.sql': 'code', '.graphql': 'code', '.gql': 'code', '.proto': 'code',

  // Code — build / patch / log
  '.tex': 'code', '.diff': 'code', '.patch': 'code', '.log': 'code',
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

/** Whether a render mode represents a binary (non-text) artifact. */
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

/** Determine effective render mode: use override if set and valid, else infer from extension. Default 'markdown' for unknown/no extension (artifacts are typically prose). */
export function getEffectiveRenderMode(title: string, override: RenderMode | null): RenderMode {
  if (override && override in RENDER_MODE_INFO) return override
  return EXTENSION_RENDER_MODES[getExtensionFromTitle(title)] ?? 'markdown'
}

export interface TaskArtifact {
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

export interface CreateArtifactInput {
  taskId: string
  title: string
  folderId?: string | null
  renderMode?: RenderMode
  content?: string
  language?: string | null
}

export interface UpdateArtifactInput {
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

export interface ArtifactFolder {
  id: string
  task_id: string
  parent_id: string | null
  name: string
  order: number
  created_at: string
}

export interface CreateArtifactFolderInput {
  taskId: string
  name: string
  parentId?: string | null
}

export interface UpdateArtifactFolderInput {
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
  // Diff panel collapsed file keys (JSON array of `${source}:${path}` strings)
  diff_collapsed_files: string[] | null
  // Git panel active sub-tab (persisted per task)
  git_active_tab: GitTabId | null
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
  // Active artifact selection (persisted across task switches)
  active_artifact_id: string | null
  // Multi-repo: folder name of the child repo this task is scoped to
  repo_name: string | null
  // External link (populated via JOIN)
  linear_url: string | null
  // Set when an agent PTY for this task transitioned running → idle|error and the
  // user has not yet focused the task. Cleared when the task tab gains focus.
  needs_attention: boolean
  // True once user dismisses the dev-server URL toast for this task — toast never
  // reappears for the task again.
  dev_url_toast_dismissed: boolean
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
  diffCollapsedFiles?: string[] | null
  // Git panel active sub-tab
  gitActiveTab?: GitTabId | null
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
  // Blocked
  isBlocked?: boolean
  blockedComment?: string | null
  // Active artifact
  activeArtifactId?: string | null
  // Multi-repo
  repoName?: string | null
  // Reparent: undefined = no change, null = detach to root, string = new parent id
  parentId?: string | null
  // Attention flag (true = set, false = clear)
  needsAttention?: boolean
  // Persisted dismissal of the dev-server URL detected toast (per task)
  devUrlToastDismissed?: boolean
}
