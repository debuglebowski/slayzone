import type { TerminalMode } from '@slayzone/terminal/shared'
import type { ProviderConfig, PanelVisibility, WebPanelUrls } from './types'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'

export interface TaskTemplate {
  id: string
  project_id: string
  name: string
  description: string | null
  terminal_mode: TerminalMode | null
  provider_config: ProviderConfig | null
  panel_visibility: PanelVisibility | null
  browser_tabs: BrowserTabsState | null
  web_panel_urls: WebPanelUrls | null
  dangerously_skip_permissions: boolean | null
  default_status: string | null
  default_priority: number | null
  is_default: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export interface CreateTaskTemplateInput {
  projectId: string
  name: string
  description?: string | null
  terminalMode?: TerminalMode | null
  providerConfig?: ProviderConfig | null
  panelVisibility?: PanelVisibility | null
  browserTabs?: BrowserTabsState | null
  webPanelUrls?: WebPanelUrls | null
  dangerouslySkipPermissions?: boolean | null
  defaultStatus?: string | null
  defaultPriority?: number | null
  isDefault?: boolean
}

export interface UpdateTaskTemplateInput {
  id: string
  name?: string
  description?: string | null
  terminalMode?: TerminalMode | null
  providerConfig?: ProviderConfig | null
  panelVisibility?: PanelVisibility | null
  browserTabs?: BrowserTabsState | null
  webPanelUrls?: WebPanelUrls | null
  dangerouslySkipPermissions?: boolean | null
  defaultStatus?: string | null
  defaultPriority?: number | null
  isDefault?: boolean
}
