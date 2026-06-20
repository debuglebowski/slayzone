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

// Single source of truth lives in @slayzone/onboarding (the checklist owns these);
// re-exported here so existing app-shell import sites keep resolving.
export { COMMUNITY_DISCORD_URL, COMMUNITY_X_URL } from '@slayzone/onboarding'
