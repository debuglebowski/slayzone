import type { IntegrationProvider } from '../shared'

export interface ProviderUiConfig {
  displayName: string
  groupLabel: string
  scopeLabel: string
  hasScopes: boolean
  supportsTwoWay: boolean
}

export const PROVIDER_CONFIG: Record<IntegrationProvider, ProviderUiConfig> = {
  linear: {
    displayName: 'Linear',
    groupLabel: 'Team',
    scopeLabel: 'Project',
    hasScopes: true,
    supportsTwoWay: true
  },
  github: {
    displayName: 'GitHub Projects',
    groupLabel: 'Repository',
    scopeLabel: 'Project',
    hasScopes: true,
    supportsTwoWay: false
  },
  jira: {
    displayName: 'Jira',
    groupLabel: 'Project',
    scopeLabel: '',
    hasScopes: false,
    supportsTwoWay: true
  }
}

export function providerDisplayName(provider: IntegrationProvider): string {
  return PROVIDER_CONFIG[provider]?.displayName ?? provider
}
