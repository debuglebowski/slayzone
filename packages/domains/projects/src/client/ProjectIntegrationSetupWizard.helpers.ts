import type { IntegrationSyncMode } from '@slayzone/integrations/shared'
import type { ProjectIntegrationProvider, WizardSyncMode } from './ProjectIntegrationSetupWizard.types'

export function toWizardSyncMode(syncMode: IntegrationSyncMode | undefined): WizardSyncMode {
  return syncMode === 'two_way' ? 'two_way' : 'one_way_import'
}

export function toPersistedSyncMode(syncMode: WizardSyncMode): IntegrationSyncMode {
  return syncMode === 'two_way' ? 'two_way' : 'one_way'
}

export function providerLabel(provider: ProjectIntegrationProvider): string {
  return provider === 'github' ? 'GitHub Projects' : 'Linear'
}

export function providerConnectionLabel(provider: ProjectIntegrationProvider): string {
  return provider === 'github' ? 'GitHub' : 'Linear'
}

export function providerCredentialLabel(provider: ProjectIntegrationProvider): string {
  return provider === 'github' ? 'Personal access token' : 'Personal API key'
}

export function providerCredentialPlaceholder(provider: ProjectIntegrationProvider): string {
  return provider === 'github' ? 'github_pat_***' : 'lin_api_***'
}
