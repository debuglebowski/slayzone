import type { IntegrationProvider } from '../../shared'
import type { ProviderAdapter } from './types'

const adapters = new Map<IntegrationProvider, ProviderAdapter>()

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.provider, adapter)
}

export function getAdapter(provider: IntegrationProvider): ProviderAdapter {
  const adapter = adapters.get(provider)
  if (!adapter) {
    throw new Error(`No adapter registered for provider: ${provider}`)
  }
  return adapter
}

export function getRegisteredProviders(): IntegrationProvider[] {
  return [...adapters.keys()]
}
