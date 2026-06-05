import type { ProjectStartMode } from '@slayzone/projects'

export type ProjectSettingsTab =
  | 'general'
  | 'environment'
  | 'tasks'
  | 'tasks/general'
  | 'tasks/statuses'
  | 'integrations'
  | 'ai-config'
  | 'tests'
export type ProjectIntegrationOnboardingProvider = Exclude<ProjectStartMode, 'scratch'>
export type ContextManagerSection =
  | 'providers'
  | 'instructions'
  | 'skill'
  | 'mcp'
  | 'files'
  | 'provider-sync'
  | 'skills'
  | 'mcps'

export const COMMUNITY_DISCORD_URL = 'https://discord.gg/g7xPHXaU98'
export const COMMUNITY_X_URL = 'https://x.com/debuglebowski'
