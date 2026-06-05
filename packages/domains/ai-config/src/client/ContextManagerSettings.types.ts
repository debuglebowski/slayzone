import type { AiConfigItem, AiConfigScope, CliProviderInfo } from '../shared'

export type ContextManagerSection =
  | 'providers'
  | 'instructions'
  | 'skill'
  | 'mcp'
  | 'files'
  | 'provider-sync'
  | 'skills'
  | 'mcps'

export type Section = ContextManagerSection

export type ProjectContextManagerTab = 'config' | 'files'

export interface ContextManagerSettingsProps {
  scope: AiConfigScope
  projectId: string | null
  projectPath?: string | null
  projectName?: string
  projectTab?: ProjectContextManagerTab
  onOpenContextManager?: (section: ContextManagerSection) => void
  initialSection?: ContextManagerSection | null
}

export interface OverviewData {
  instructions: { content: string } | null
  skills: AiConfigItem[]
  providers: CliProviderInfo[]
}
