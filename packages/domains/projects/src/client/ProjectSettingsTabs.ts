import type { ComponentType } from 'react'
import type { Project } from '@slayzone/projects-contracts'

/**
 * Tabs (and the data hooks behind them) ProjectSettingsDialog embeds from features
 * built ON TOP of projects (settings' tag editor, integrations). Projects owns this
 * contract; the composing app injects the real implementations once via
 * registerProjectSettingsTabs() — so projects never imports those features. Each
 * feature ships its half of the binding (`@slayzone/integrations/project-settings-tabs`).
 */

export interface TagsSettingsTabProps {
  projectId: string
}

/** Providers an integration onboarding flow can open the Integrations tab on. */
export type IntegrationOnboardingProvider = 'linear' | 'github' | 'jira'

export interface IntegrationsSettingsTabProps {
  project: Project
  open: boolean
  onUpdated: (project: Project) => void
  integrationOnboardingProvider?: IntegrationOnboardingProvider | null
  onIntegrationOnboardingHandled?: () => void
}

/**
 * Resolves the display name of the provider whose status sync locks a project's
 * statuses, or null (none, or unknown — it never rejects).
 */
export type StatusSyncLockLookup = (projectId: string) => Promise<string | null>

export interface ProjectSettingsTabs {
  TagsSettingsTab: ComponentType<TagsSettingsTabProps>
  IntegrationsTab: ComponentType<IntegrationsSettingsTabProps>
  /**
   * The status-sync lock lookup. The returned function's identity changes only when
   * what it reads through (query client, hub client) does — the dialog re-checks then.
   */
  useStatusSyncLockLookup: () => StatusSyncLockLookup
}

let registered: ProjectSettingsTabs | null = null

/**
 * Called ONCE by the composing app at module scope, before its first render. The
 * dialog calls the injected hook, so it must be the same function on every render
 * for the app's lifetime — a module-level registration (not a context, whose value
 * may change) is what makes that hold. Re-registering the same object is a no-op;
 * a different one throws.
 */
export function registerProjectSettingsTabs(tabs: ProjectSettingsTabs): void {
  if (registered && registered !== tabs) {
    throw new Error('registerProjectSettingsTabs: project settings tabs are already registered')
  }
  registered = tabs
}

/** The app-registered tabs. Throws if the app never called registerProjectSettingsTabs. */
export function getProjectSettingsTabs(): ProjectSettingsTabs {
  if (!registered) {
    throw new Error('getProjectSettingsTabs: the app must call registerProjectSettingsTabs first')
  }
  return registered
}

/** The injected `useStatusSyncLockLookup` (fixed for the app's lifetime — see registerProjectSettingsTabs). */
export function useStatusSyncLockLookup(): StatusSyncLockLookup {
  return getProjectSettingsTabs().useStatusSyncLockLookup()
}
