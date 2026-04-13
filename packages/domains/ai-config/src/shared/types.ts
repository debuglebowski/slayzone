export type AiConfigItemType = 'skill' | 'doc' | 'root_instructions'
export type AiConfigScope = 'library' | 'project'
export type ConfigLevel = 'computer' | 'project' | 'library'

export interface AiConfigItem {
  id: string
  type: AiConfigItemType
  scope: AiConfigScope
  project_id: string | null
  name: string
  slug: string
  content: string
  metadata_json: string
  created_at: string
  updated_at: string
}

export interface ListAiConfigItemsInput {
  scope: AiConfigScope
  projectId?: string | null
  type?: AiConfigItemType
}

export interface CreateAiConfigItemInput {
  type: AiConfigItemType
  scope: AiConfigScope
  projectId?: string | null
  slug: string
  content?: string
}

export interface UpdateAiConfigItemInput {
  id: string
  type?: AiConfigItemType
  scope?: AiConfigScope
  projectId?: string | null
  slug?: string
  content?: string
}

export interface AiConfigProjectSelection {
  id: string
  project_id: string
  item_id: string
  provider: string
  target_path: string
  content_hash: string | null
  selected_at: string
}

export interface SetAiConfigProjectSelectionInput {
  projectId: string
  itemId: string
  targetPath: string
  provider?: CliProvider
}

export type ContextFileCategory = 'claude' | 'codex' | 'agents' | 'mcp' | 'custom'

export interface ContextFileInfo {
  path: string
  name: string
  exists: boolean
  category: ContextFileCategory
}

export type SyncHealth = 'synced' | 'stale' | 'unmanaged' | 'not_synced'
export type SyncReason = 'external_edit' | 'missing_file' | 'not_linked' | 'provider_disabled'

export type SkillValidationSeverity = 'error' | 'warning'
export type SkillValidationStatus = 'valid' | 'warning' | 'invalid'

export interface SkillValidationIssue {
  code: string
  severity: SkillValidationSeverity
  message: string
  line: number | null
}

export interface SkillValidationState {
  status: SkillValidationStatus
  issues: SkillValidationIssue[]
}

// CLI provider types
export type CliProvider = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'qwen' | 'copilot'
export type CliProviderStatus = 'active' | 'placeholder'

export interface CliProviderInfo {
  id: string
  name: string
  kind: string
  enabled: boolean
  status: CliProviderStatus
}

export type ContextFileProvider = CliProvider | 'manual'

export interface ContextTreeEntry {
  path: string
  relativePath: string
  exists: boolean
  category: ContextFileCategory | 'skill'
  provider?: CliProvider
  linkedItemId: string | null
  syncHealth: SyncHealth
  syncReason: SyncReason | null
}

export interface LoadLibraryItemInput {
  projectId: string
  projectPath: string
  itemId: string
  providers: CliProvider[]
  manualPath?: string
}

export interface ProviderPathMapping {
  rootInstructions: string | null
  skillsDir: string | null
}

export interface SyncAllInput {
  projectId: string
  projectPath: string
  providers?: CliProvider[]
  pruneUnmanaged?: boolean
  itemId?: string
}

export interface SyncResult {
  written: { path: string; provider: CliProvider }[]
  deleted: { path: string; provider: CliProvider; kind: 'skill' | 'instruction' | 'mcp' }[]
  conflicts: SyncConflict[]
}

export interface SyncConflict {
  path: string
  provider: CliProvider
  itemId: string
  reason: 'external_edit'
}

export interface RootInstructionsResult {
  content: string
  providerHealth: Partial<Record<CliProvider, { health: SyncHealth; reason: SyncReason | null; contentHash?: string | null; lineCount?: number | null }>>
}

export interface ProviderFileContent {
  provider: CliProvider
  content: string
  exists: boolean
}

export interface ProjectSkillStatus {
  item: AiConfigItem
  providers: Partial<Record<CliProvider, {
    path: string
    syncHealth: SyncHealth
    syncReason: SyncReason | null
    diskContent?: string
  }>>
}

// Computer-level file management (~/.provider/...)
export interface ComputerFileEntry {
  path: string
  name: string
  provider: string
  category: 'instructions' | 'skill' | 'mcp'
  exists: boolean
  contentHash?: string
  lineCount?: number
}

// MCP server management
export type McpTarget = CliProvider

export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
  type?: string
}

export interface McpConfigFileResult {
  provider: McpTarget
  exists: boolean
  writable: boolean
  servers: Record<string, McpServerConfig>
}

export interface ProjectMcpServer {
  id: string
  name: string
  config: McpServerConfig
  curated: boolean
  providers: McpTarget[]
  category?: string
}

export interface WriteMcpServerInput {
  projectPath: string
  provider: McpTarget
  serverKey: string
  config: McpServerConfig
}

export interface RemoveMcpServerInput {
  projectPath: string
  provider: McpTarget
  serverKey: string
}

// Computer-level MCP management
export interface WriteComputerMcpServerInput {
  provider: McpTarget
  serverKey: string
  config: McpServerConfig
}

export interface RemoveComputerMcpServerInput {
  provider: McpTarget
  serverKey: string
}

// Skill Marketplace
export type SkillRegistrySourceType = 'builtin' | 'github'

export interface SkillRegistry {
  id: string
  name: string
  description: string
  source_type: SkillRegistrySourceType
  github_owner: string | null
  github_repo: string | null
  github_branch: string | null
  github_path: string | null
  icon_url: string | null
  enabled: boolean
  last_synced_at: string | null
  created_at: string
  updated_at: string
  entry_count?: number
}

export interface SkillRegistryEntry {
  id: string
  registry_id: string
  slug: string
  name: string
  description: string
  content: string
  version: string | null
  category: string
  author: string | null
  content_hash: string
  fetched_at: string
  installed?: boolean
  installed_item_id?: string | null
  installed_scope?: string | null
  installed_library_item_id?: string | null
  installed_project_item_id?: string | null
  has_update?: boolean
  registry_name?: string
}

export interface AddRegistryInput {
  githubUrl: string
  branch?: string
  path?: string
}

export interface InstallSkillInput {
  entryId: string
  scope: AiConfigScope
  projectId?: string | null
}

export interface SkillUpdateInfo {
  itemId: string
  entryId: string
  currentVersion: string
  latestVersion: string
  slug: string
}

export interface MarketplaceProvenance {
  registryId: string
  registryName: string | null
  entryId: string
  installedVersion: string | null
  installedAt: string
}

export interface ListEntriesInput {
  registryId?: string
  search?: string
  category?: string
  projectId?: string | null
}
